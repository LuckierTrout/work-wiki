import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { _resetSlugTenants, loadSlugTenants, useSlugTenants } from "@/hooks/useSlugTenants";
import { ArticleView } from "@/components/ArticleView";
import { VaultExplorer } from "@/components/VaultExplorer";
import { ChatWorkspace } from "@/components/ChatWorkspace";
import { KnowledgeStudio } from "@/components/KnowledgeStudio";
import { RecentIngests } from "@/components/RecentIngests";
import { ActionInbox } from "@/components/ActionInbox";
import { BulkDocumentImport } from "@/components/BulkDocumentImport";
import { IngestSuccess } from "@/components/IngestSuccess";
import { BatchItemRow } from "@/components/BatchItemRow";
import { QueryResultPanel } from "@/components/QueryResultPanel";
import { GlobalSearch } from "@/components/GlobalSearch";
import { forgetRecentJobs, getRecentJobIds } from "@/lib/recent-ingests";
import type { BatchItem } from "@/components/BatchItemRow";
import type { ActionItem } from "@/lib/action-items";
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
 * covers the five RENDERER call sites. The eleven components below were
 * converted in the same sweep and their anchors got only per-hook coverage —
 * `useSlugTenants`
 * and `resolveSlugPath` each have their own suite, and neither can see which
 * components ask them — so reverting any one call site to `slugPath(...)`, or
 * dropping a `slugTenants` prop, left the entire run green while every internal
 * link in that surface went back to a wrong-handle `/u/yopedia/…` hop.
 *
 * The last four (DW-590, DW-699) are the ones whose ANCHORS the sweep left with
 * no rendering test — `IngestSuccess`, `BatchItemRow`, and `QueryResultPanel`'s
 * Sources chips and saved-answer banner. The panel is not otherwise untested:
 * the sibling file mounts it for its IN-CONTENT links, but always with
 * `sources: []` and no save state, so neither of these two branches renders
 * there. Last comes the ONE call site here that emits no anchor at all:
 * `useGlobalSearch`'s `router.push`, witnessed on the argument the router
 * actually received rather than on a rendered `href`.
 *
 * Every other assertion is on the RENDERED `href`. A component that obtains
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

/**
 * A route table value meaning "this endpoint is DOWN" — the stub rejects it.
 *
 * Deleting the entry instead would also make the stub throw, but through the
 * `unexpected fetch` guard, whose whole job is the opposite claim: a component
 * asked for a URL no fixture ever described, which is a bug in the test or a
 * new call site, not a state under test. An outage is a DESCRIBED state, so it
 * gets its own value and its own message — and a fixture that later forgets a
 * route still fails as "unexpected", not as a staged outage.
 */
const ROUTE_UNAVAILABLE = Symbol("route unavailable");

/** Per-test route table, consulted by the one `fetch` stub below. */
let routes: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  // Ordering-independent hygiene, not a fix for an observed failure.
  // `BulkDocumentImport`'s upload calls `rememberRecentJob`, and jsdom keeps ONE
  // store for the whole file, so `RecentIngests` — the only component here that
  // reads stored job ids — could otherwise start a case holding another case's.
  // It would survive that today (every one of its reads is individually
  // try/catch'd, so the strict stub's throw only sets `errored`) and its
  // describe is declared first anyway; this just means neither fact has to stay
  // true for the fixtures below to describe what is on screen.
  //
  // Reset through the module's OWN readers rather than `window.localStorage`:
  // both swallow a storage failure the way the components do, so this line
  // behaves on a runtime that publishes no `window.localStorage` (Node 26
  // shadows jsdom's) instead of throwing before the first assertion.
  forgetRecentJobs(getRecentJobIds());
  routes = {
    // The readability-gated map every CLIENT component here reads.
    "/api/wiki/routes": { ...SLUG_TENANTS },
  };
  fetchMock = vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((route) => route === url);
    if (key === undefined) throw new Error(`unexpected fetch: ${url}`);
    if (routes[key] === ROUTE_UNAVAILABLE) {
      throw new Error(`staged outage: ${url}`);
    }
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

// ---------------------------------------------------------------------------
// RecentIngests
// ---------------------------------------------------------------------------

/**
 * The two remaining converted call sites in this component (DW-259).
 *
 * `recent-ingests-read-only.test.tsx` is the reason they were uncovered: it
 * MOCKS `useSlugTenants` to a `/u/yopedia/${slug}` stub, which is precisely the
 * answer a reverted `slugPath(...)` emits — so that suite stays green through
 * exactly the regression this file exists to catch. Nothing is mocked here but
 * the network.
 *
 * The two rows are given DIFFERENT owners on purpose: one tenant for the whole
 * list is a distinguishable failure from a per-slug lookup.
 */
const LEDGER_ROUTE = "/api/ingest/history?limit=20";
const EMAIL_JOBS_ROUTE = "/api/ingest/jobs?source=email&limit=20";

/** The email row's link text, which is the subject rather than the slug. */
const EMAIL_SUBJECT = "Quarterly numbers";

function renderRecentIngests() {
  routes[LEDGER_ROUTE] = {
    entries: [
      {
        ingest_id: "ing-1",
        source_url: "https://example.com/report",
        primary_slug: "target",
        finished_at: "2026-01-01T00:00:00.000Z",
        // What the ledger actually writes (`src/lib/ingest.ts`), and what the
        // sibling fixture in `recent-ingests-read-only.test.tsx` uses. Inert
        // for this assertion, but a fixture is also a claim about the wire.
        status: "completed",
        // Anything but "email": the ledger list filters those out, since the
        // email jobs read below is what renders them.
        source_type: "url",
      },
    ],
    readOnly: false,
  };
  routes[EMAIL_JOBS_ROUTE] = {
    jobs: [
      {
        jobId: "job-email-1",
        // Only a terminal job carries a page to link to; a queued one would
        // also arm the component's 4s repoll.
        status: "done",
        slug: "other",
        createdAt: "2026-01-01T00:00:00.000Z",
        email: {
          from: "someone@example.com",
          subject: EMAIL_SUBJECT,
          attachmentNames: [],
        },
      },
    ],
  };
  // No stored job ids (the file's `beforeEach` clears them) and no running job,
  // so `polls < 90 && stillRunning` is false and NO timer is armed — this
  // component needs no clock.
  return render(<RecentIngests />);
}

describe("RecentIngests", () => {
  it("addresses a ledger row by the ingested page's owner", async () => {
    renderRecentIngests();
    // The row's link text IS the slug, so a component that rendered no anchor
    // fails on the missing link rather than passing on an absent element.
    expect(await hrefOf("target")).toBe(ALICE_TARGET);
  });

  it("addresses an emailed note by ITS owner, not the ledger's", async () => {
    renderRecentIngests();
    // `other` is bob's while the ledger row above is alice's: resolving the
    // list against one tenant answers this row wrong, and reverting the call
    // site answers `/u/yopedia/other`.
    expect(await hrefOf(EMAIL_SUBJECT)).toBe(BOB_OTHER);
  });

  it("keeps both rows of one render on their own owners", async () => {
    renderRecentIngests();
    // Two call sites, one mount: converting one and leaving the other is the
    // failure either single assertion above would miss.
    expect(await hrefOf(EMAIL_SUBJECT)).toBe(BOB_OTHER);
    expect(await hrefOf("target")).toBe(ALICE_TARGET);
  });
});

// ---------------------------------------------------------------------------
// ActionInbox
// ---------------------------------------------------------------------------

/**
 * The cited-source chip (DW-259).
 *
 * This is the component's FIRST test of any kind — no suite under `src/`
 * referenced `ActionInbox` at all — so its one converted call site could be
 * reverted with the whole run green.
 */
const INBOX_ITEM: ActionItem = {
  id: "act-1",
  title: "Chase the quarterly numbers",
  priority: "medium",
  // The default tab is "inbox"; anything else renders the empty state and the
  // chip with it.
  status: "inbox",
  sourceSlug: "target",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("ActionInbox", () => {
  it("addresses a to-do's cited source by the SOURCE page's owner", async () => {
    routes["/api/action-items"] = { items: [INBOX_ITEM] };

    render(<ActionInbox />);

    // The chip names the slug it cites, so a dropped anchor fails here rather
    // than leaving an assertion with nothing to check.
    expect(await hrefOf("source · target")).toBe(ALICE_TARGET);
  });
});

// ---------------------------------------------------------------------------
// BulkDocumentImport
// ---------------------------------------------------------------------------

/**
 * The manifest's "Open page →" link (DW-259).
 *
 * The only case in this file that needs a clock: the row reaches `done` through
 * a 2500ms status poll, and the link is rendered only for
 * `item.status === "done" && item.slug`. The `act` + `advanceTimersByTimeAsync`
 * idiom is `data-version-watcher.test.tsx`'s.
 */
const DOCUMENT_UPLOAD_ROUTE = "/api/ingest/document";
const BULK_JOB_ID = "job-bulk-1";

describe("BulkDocumentImport", () => {
  /** Let the in-flight request settle, and optionally run the poll forward. */
  async function settle(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  beforeEach(() => {
    // Registered AFTER the file-level hook, which vitest therefore runs first —
    // so `loadSlugTenants()` warms the map on a real clock.
    vi.useFakeTimers();
  });

  afterEach(() => {
    // This describe's own `afterEach`, which vitest runs BEFORE the file-level
    // one — so `cleanup()` still unmounts on a real clock.
    vi.useRealTimers();
  });

  it("addresses an imported document by the created page's owner", async () => {
    routes[DOCUMENT_UPLOAD_ROUTE] = { queued: true, jobId: BULK_JOB_ID };
    routes[`/api/ingest/status/${BULK_JOB_ID}`] = { status: "done", slug: "target" };

    const { container } = render(<BulkDocumentImport vaultId={null} />);

    // A MIME-only name, the selection `bulk-document-accept-parity.test.tsx`
    // proves `selectBulkDocuments` accepts. `input.files` is read-only in
    // jsdom, so it is defined onto the element rather than passed through
    // `fireEvent`'s `target`.
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    // Checked rather than cast: a renamed or removed picker would otherwise
    // surface as an opaque TypeError inside `Object.defineProperty`.
    expect(input, "no file input to pick a document with").not.toBeNull();
    Object.defineProperty(input, "files", {
      value: [
        new File([new Uint8Array(4)], "report", {
          type: "application/pdf",
          lastModified: 1,
        }),
      ],
      configurable: true,
    });
    fireEvent.change(input!);

    // SELECTED — the manifest took the file. Nothing has been uploaded yet;
    // this is only what makes the row's later states about a real row.
    const row = container.querySelector("li");
    expect(row, "the picked file was not added to the manifest").not.toBeNull();
    expect(within(row as HTMLElement).getByText("report")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Import 1 document/ }));
    await settle(); // the POST resolves and arms the status poll
    // QUEUED — the POST was accepted and a job id came back. Asserted before
    // the poll runs so a rejected upload reads as "the upload never queued"
    // rather than as a link that failed to appear two and a half seconds later.
    expect(
      within(row as HTMLElement).getByText("queued"),
      "the upload never queued, so the poll below had no job to ask about",
    ).toBeTruthy();

    // 2500ms is `BulkDocumentImport.tsx`'s status-poll `setTimeout` — the one
    // interval between a queued row and a `done` one. If that number moves,
    // this is the line that has to move with it.
    await settle(2500); // the poll answers `{ status: "done", slug: "target" }`

    // Rendered only once the row is `done` WITH a slug, so this cannot pass on
    // an upload that stalled.
    const link = screen.getByRole("link", { name: "Open page →" });
    expect(link.getAttribute("href")).toBe(ALICE_TARGET);
  });
});

// ---------------------------------------------------------------------------
// IngestSuccess
// ---------------------------------------------------------------------------

/**
 * The confirmation screen's two call sites (DW-590).
 *
 * Plain props and no network of its own: the component asks `useSlugTenants()`
 * directly, so the warm map is on screen from the first paint and the only way
 * either anchor can be wrong is a reverted call site.
 *
 * `target` is alice's and `other` is bob's, so the related row cannot be
 * satisfied by whatever tenant the primary link resolved to.
 */
describe("IngestSuccess", () => {
  function renderSuccess() {
    return render(
      <IngestSuccess slug="target" relatedUpdated={["other"]} onReset={() => {}} />,
    );
  }

  it("addresses the ingested page by ITS owner", async () => {
    renderSuccess();
    // Matched loosely because the label carries typographic quotes around the
    // slug; the assertion that matters is the href, not the punctuation.
    const link = await screen.findByRole("link", { name: /^View .*target.*→$/ });
    expect(link.getAttribute("href")).toBe(ALICE_TARGET);
  });

  it("addresses each related page by its OWN owner", async () => {
    renderSuccess();
    // A second owner, so "one tenant for the whole screen" — which is what the
    // primary link's answer reused for the list would look like — fails here.
    expect(await hrefOf("other")).toBe(BOB_OTHER);
  });

  it("keeps both call sites of one render on the map", async () => {
    renderSuccess();
    const link = await screen.findByRole("link", { name: /^View .*target.*→$/ });
    expect(link.getAttribute("href")).toBe(ALICE_TARGET);
    expect(await hrefOf("other")).toBe(BOB_OTHER);
  });
});

// ---------------------------------------------------------------------------
// BatchItemRow
// ---------------------------------------------------------------------------

/**
 * The batch manifest's per-row link (DW-590).
 *
 * The row receives `hrefForSlug` as a PROP, so a test that handed it a stub
 * returning `/u/yopedia/<slug>` would assert the very answer a reverted call
 * site emits and pass either way. The harness below therefore obtains the
 * function from the real hook, exactly as `BatchIngestForm` does, so the map is
 * what has to produce the row's href.
 *
 * What this does NOT witness is `BatchIngestForm.tsx:319` itself: the harness
 * REPLICATES that hand-off rather than executing it, so dropping the real one
 * still leaves the suite green. Reaching the row through the form would mean
 * driving its NDJSON upload, and nothing currently mounts `BatchIngestForm` on
 * any route — so the uncovered half has no reachable surface today.
 */

/** `BatchIngestForm.tsx:319`'s wiring, minus its NDJSON upload. */
function BatchRows({ items }: { items: BatchItem[] }) {
  const { hrefForSlug } = useSlugTenants();
  return (
    <ul>
      {items.map((item, i) => (
        <BatchItemRow key={i} item={item} hrefForSlug={hrefForSlug} />
      ))}
    </ul>
  );
}

/** Two finished rows with two DIFFERENT owners, plus one that links to nothing. */
const BATCH_ITEMS: BatchItem[] = [
  { url: "https://example.com/one", status: "success", slug: "target" },
  { url: "https://example.com/two", status: "success", slug: "other" },
  // Not a link at all — the `status === "success" && item.slug` gate is what
  // this row proves is still a gate, so "every row links somewhere" cannot
  // pass by accident.
  { url: "https://example.com/three", status: "error", error: "fetch failed" },
];

describe("BatchItemRow", () => {
  it("addresses each created page by the page's own owner", async () => {
    render(<BatchRows items={BATCH_ITEMS} />);

    // The row's link text IS the slug, so a row that rendered no anchor fails
    // on the missing link rather than passing on an absent element.
    expect(await hrefOf("target")).toBe(ALICE_TARGET);
    expect(await hrefOf("other")).toBe(BOB_OTHER);
  });

  it("renders no anchor for a row that produced no page", async () => {
    render(<BatchRows items={BATCH_ITEMS} />);
    await screen.findByRole("link", { name: "target" });

    // Two links for three rows: the failed row is the reason the two above are
    // about resolution rather than about "there are links on screen".
    expect(screen.getAllByRole("link").length).toBe(2);
    expect(screen.getByText("fetch failed")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// QueryResultPanel
// ---------------------------------------------------------------------------

/**
 * The answer panel's Sources chips and its saved-answer banner (DW-699).
 *
 * `renderer-slug-tenant-adoption.test.tsx` already owns this component's
 * IN-CONTENT wikilinks, so the answer body here is deliberately link-free: the
 * two call sites below are the panel's own, and neither is reachable through
 * the renderer.
 *
 * The banner's href is `saveState.url ?? hrefForSlug(saveState.slug)`. The
 * `url` half is the server's canonical answer for a page created just now; the
 * FALLBACK half is the `hrefForSlug` call site, so the save fixture answers
 * with a slug and no url — the one response shape that reaches it.
 */
const ANSWER = "A prose answer that cites nothing inline.";
const QUESTION = "who owns target?";

describe("QueryResultPanel", () => {
  it("addresses each source chip by the cited page's owner", async () => {
    render(
      <QueryResultPanel
        result={{ answer: ANSWER, sources: ["target", "other"] }}
        streaming={false}
        question={QUESTION}
        currentHistoryId={null}
      />,
    );

    // The chip names the slug it cites. A second owner on the second chip is
    // what makes this one lookup per chip rather than one tenant per answer.
    expect(await hrefOf("target")).toBe(ALICE_TARGET);
    expect(await hrefOf("other")).toBe(BOB_OTHER);
  });

  it("falls back to the map when the save response carries no url", async () => {
    // No chips, so the only `target` link on screen is the banner's.
    render(
      <QueryResultPanel
        result={{ answer: ANSWER, sources: [] }}
        streaming={false}
        question={QUESTION}
        currentHistoryId={null}
      />,
    );

    // An older route (or a degraded one) answers with the slug alone; the
    // banner must still address the page's real owner rather than taking a
    // wrong-handle hop on every saved answer.
    routes["/api/query/save"] = { slug: "target" };

    fireEvent.click(await screen.findByRole("button", { name: "Save to Wiki" }));
    // `handleSaveClick` pre-fills the title from the question, so the submit is
    // already enabled and nothing has to be typed.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const link = await screen.findByRole("link", { name: "View →" });
    expect(link.getAttribute("href")).toBe(ALICE_TARGET);

    // (the `url` half of the same expression is the case below)
    // `currentHistoryId` is null, so the save is the panel's ONLY write.
    // Asserted rather than left to the `unexpected fetch` guard because the
    // history POST is wrapped in its own `catch` (`QueryResultPanel.tsx:146`),
    // so the stub's throw would be SWALLOWED and the case would still pass.
    const posted = fetchMock.mock.calls.map(([url]) => url);
    expect(posted).toContain("/api/query/save");
    expect(posted).not.toContain("/api/query/history");
  });

  it("links a saved answer by the URL the save returned", async () => {
    render(
      <QueryResultPanel
        result={{ answer: ANSWER, sources: [] }}
        streaming={false}
        question={QUESTION}
        currentHistoryId={null}
      />,
    );

    // The other half of `saveState.url ?? hrefForSlug(...)`. A slug created
    // just now CANNOT be in the session-cached map, so a panel that dropped the
    // `url` and always mapped would answer `/u/yopedia/fresh-answer` and 308 on
    // every fresh save — which the fallback case above cannot see, because
    // there the map already holds the right answer. A THIRD owner, so this is
    // also distinguishable from both canonical hrefs in the fixture.
    routes["/api/query/save"] = { slug: "fresh-answer", url: "/u/carol/fresh-answer" };

    fireEvent.click(await screen.findByRole("button", { name: "Save to Wiki" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const link = await screen.findByRole("link", { name: "View →" });
    expect(link.getAttribute("href")).toBe("/u/carol/fresh-answer");
  });
});

// ---------------------------------------------------------------------------
// GlobalSearch
// ---------------------------------------------------------------------------

/**
 * The one converted call site in this file that renders NO anchor (DW-590).
 *
 * `useGlobalSearch`'s `navigate(slug)` ends in `router.push(hrefForSlug(slug))`,
 * so the witness is the argument the router actually received. Asserting that
 * the hook imports `useSlugTenants` would pass on a `router.push(slugPath(...))`
 * left behind next to it.
 */
const WIKI_PAGES_ROUTE = "/api/wiki";
const SEARCH_QUERY = "tar";

describe("GlobalSearch", () => {
  beforeEach(() => {
    routes[WIKI_PAGES_ROUTE] = { pages: [{ slug: "target", title: "Target page" }] };
    // The 300ms content-search debounce is normally cleared by unmount, but the
    // stub throws on any URL no fixture describes — so a case that stays mounted
    // past it must not fail as "unexpected fetch" instead of as itself.
    routes[`/api/wiki/search?q=${encodeURIComponent(SEARCH_QUERY)}`] = { results: [] };
    // `nav.router` is hoisted and shared by the whole file, so its call log is
    // only this case's if this case empties it first.
    nav.router.push.mockClear();
  });

  // And left empty again, so this is the only describe whose cases can put a
  // navigation in the shared log.
  afterEach(() => {
    nav.router.push.mockClear();
  });

  it("navigates to the selected page's OWN owner", async () => {
    render(<GlobalSearch />);

    const input = screen.getByLabelText("Search wiki pages");
    fireEvent.focus(input); // opens the dropdown and loads the page list
    fireEvent.change(input, { target: { value: SEARCH_QUERY } });

    // The dropdown only renders once the page list has arrived AND the query
    // matches one, so reaching this is what makes the mousedown below a real
    // selection rather than a click on nothing.
    const option = await screen.findByRole("option", { name: "Target page" });
    fireEvent.mouseDown(option);

    // The canonical href, not `/u/yopedia/target` and not the raw slug.
    expect(nav.router.push).toHaveBeenCalledTimes(1);
    expect(nav.router.push).toHaveBeenCalledWith(ALICE_TARGET);
  });
});

// ---------------------------------------------------------------------------
// The degraded map, and the recovery out of it
// ---------------------------------------------------------------------------

/**
 * What every component in this file is built to survive, finally witnessed on a
 * mounted one (DW-262), plus the refresh path out of it (DW-234).
 *
 * Every case above warms the session cache first, so the map is on screen from
 * the first paint — which means the FALLBACK branch each converted call site
 * carries had no component witness at all. `useSlugTenants` caches at module
 * scope, so it is not enough to fail the route: this file has already warmed
 * the singleton by the time any case runs, and a warm cache never re-fetches.
 * `_resetSlugTenants()` (test-only) is what makes the module cold again, and
 * `ROUTE_UNAVAILABLE` is what keeps it that way for the mount.
 *
 * `RecentIngests` is the fixture because it is the only component here with TWO
 * map-driven rows and no `tenant` fallback prop, so the degraded answers
 * (`/u/yopedia/target`, `/u/yopedia/other`) are distinguishable from both
 * canonical ones — and it needs no clock.
 */
const DEGRADED_TARGET = "/u/yopedia/target";
const DEGRADED_OTHER = "/u/yopedia/other";

/**
 * Let a `loadSlugTenants()` chain run out: `fetch` → the two `.then`s →
 * `.catch` → `.finally`. One macrotask turn, because the number of microtask
 * turns is not something a test should have to know — and because a recovery
 * issued while the failed request is still in `inflight` would JOIN it and be
 * answered `{}`.
 */
async function settleLoad() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** How many times `/api/wiki/routes` was actually requested. */
function routeFetches() {
  return fetchMock.mock.calls.filter(([url]) => url === "/api/wiki/routes").length;
}

describe("RecentIngests with a failing /api/wiki/routes", () => {
  beforeEach(() => {
    // Registered AFTER the file-level hook, which vitest therefore runs first —
    // so this undoes its `await loadSlugTenants()` warm-up rather than racing
    // it. Both halves are needed: the sentinel fails the NEXT fetch, the reset
    // is what makes there be a next fetch.
    routes["/api/wiki/routes"] = ROUTE_UNAVAILABLE;
    _resetSlugTenants();
    // The file-level warm-up above may or may not have paid for a fetch — it
    // returns from the module cache whenever the previous case left one warm —
    // so the counts below are this case's own, not the file's running total.
    fetchMock.mockClear();
  });

  it("falls back to the DEFAULT_TENANT href for every row while the map is unavailable", async () => {
    renderRecentIngests();
    // The rows first, then the load run out. Without the settle these hrefs
    // would also be satisfied by a map that had not loaded YET — the loading
    // fallback and the failed fallback are the same string — so the fetch
    // count below is what makes this the degraded branch and not a race the
    // assertions happened to win.
    expect(await hrefOf("target")).toBe(DEGRADED_TARGET);
    await settleLoad();
    expect(routeFetches()).toBe(1); // the staged outage really was requested

    // Both rows, because "one tenant for the whole list" is exactly what the
    // fallback looks like — the assertion has to be that the rows still RENDER
    // and still link, not that the component degraded to no anchor at all.
    expect(await hrefOf("target")).toBe(DEGRADED_TARGET);
    expect(await hrefOf(EMAIL_SUBJECT)).toBe(DEGRADED_OTHER);
  });

  it("adopts a recovered map without a remount", async () => {
    renderRecentIngests();
    expect(await hrefOf("target")).toBe(DEGRADED_TARGET);
    await settleLoad(); // the failed request is out of `inflight` before we retry

    // The SAME DOM nodes, held across the recovery. If the tree were remounted
    // (or these rows re-created) the assertions below would read detached
    // elements and fail — which is what makes this "the mounted component
    // re-rendered" rather than "something on screen has the right href".
    const ledgerLink = await screen.findByRole("link", { name: "target" });
    const emailLink = await screen.findByRole("link", { name: EMAIL_SUBJECT });

    // Routes comes back, and ANOTHER caller loads it — the only recovery signal
    // the hook has. No polling, no timer and no remount is involved.
    routes["/api/wiki/routes"] = { ...SLUG_TENANTS };
    await act(async () => {
      await loadSlugTenants();
    });

    expect(ledgerLink.isConnected, "the ledger row was remounted").toBe(true);
    expect(emailLink.isConnected, "the email row was remounted").toBe(true);
    expect(ledgerLink.getAttribute("href")).toBe(ALICE_TARGET);
    expect(emailLink.getAttribute("href")).toBe(BOB_OTHER);
    // Twice: the mount's failed load and this one. A hook that re-fetched per
    // render, or once per notification, would pass every href assertion above
    // and show up only here.
    expect(routeFetches()).toBe(2);
  });

  it("recovers its hrefs when the tab regains focus, with no remount", async () => {
    // DW-723, on a real surface. The case above needs a THIRD party to call
    // `loadSlugTenants()`, and in production that party is always another
    // component MOUNTING — so a surface that goes idle after the outage (this
    // list sitting still: no navigation, no panel opening) never recovers and
    // keeps the wrong-handle 308 hop on every row until the tab is reloaded.
    // Here the trigger is only the user coming back to the window.
    //
    // The focus event is NOT inert for this fixture: `RecentIngests` registers
    // its own `window` focus listener (`RecentIngests.tsx:247-255`) that
    // resets its poll counter and re-runs `tick()`, re-reading the ledger and
    // the email jobs and re-setting their state. That is real and deliberate —
    // it is what a focus event does to this component in production, and this
    // case runs the whole of it rather than a sanitised version.
    //
    // It still isolates DW-723, for two reasons: the hrefs asserted below can
    // only come from the slug-tenant map (every row builds them through
    // `hrefForSlug`, and the ledger/jobs payloads carry slugs, never owners),
    // and `routeFetches()` counts `/api/wiki/routes` alone, so the component's
    // own two refetches cannot inflate it.
    renderRecentIngests();
    expect(await hrefOf("target")).toBe(DEGRADED_TARGET);
    await settleLoad(); // the failed request is out of `inflight` before the retry
    expect(await hrefOf(EMAIL_SUBJECT)).toBe(DEGRADED_OTHER);

    // Held across the recovery, as above: these exact nodes have to survive it,
    // or the claim is "something on screen has the right href" rather than
    // "the mounted component re-rendered".
    const ledgerLink = await screen.findByRole("link", { name: "target" });
    const emailLink = await screen.findByRole("link", { name: EMAIL_SUBJECT });

    routes["/api/wiki/routes"] = { ...SLUG_TENANTS };
    // No `loadSlugTenants()` call, no remount, no timer — one native `focus`
    // event on the window, which is what returning to the app actually fires.
    window.dispatchEvent(new Event("focus"));
    await settleLoad();

    expect(ledgerLink.isConnected, "the ledger row was remounted").toBe(true);
    expect(emailLink.isConnected, "the email row was remounted").toBe(true);
    expect(ledgerLink.getAttribute("href")).toBe(ALICE_TARGET);
    expect(emailLink.getAttribute("href")).toBe(BOB_OTHER);
    // Twice: the mount's failed load and the retry the focus event started.
    expect(routeFetches()).toBe(2);
  });
});
