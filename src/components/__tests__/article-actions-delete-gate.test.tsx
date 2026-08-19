import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ArticleActions } from "@/components/ArticleActions";
import { ArticleView } from "@/components/ArticleView";
import type { Frontmatter } from "@/lib/frontmatter";
import { canWritePage, isRealmRestrictedWrite } from "@/lib/authz";
import type { PageReadMeta } from "@/lib/authz";
import type { Principal } from "@/lib/auth";

/**
 * The Delete affordance, mounted against the server's own answer (DW-120).
 *
 * The gate used to be `isOwner || isSiteOwner`, and the only thing watching it
 * was a source scan asserting that exact string. A text pin cannot see a
 * DIVERGENCE — that the button it describes is offered to a page owner whose
 * `DELETE /api/wiki/[slug]` the realm gate always refuses — because it never
 * evaluates the server predicate at all. So this suite renders the real island
 * and compares what is on screen with `canWritePage(meta, principal, "delete")`
 * called directly, per row.
 *
 * THE ASSERTION IS AN INEQUALITY, NOT AN EQUALITY, and deliberately so. The
 * browser cannot know `ADMIN_HANDLES` (a server-only var), so an admin who is
 * not the site owner is under-offered the button. A convenience gate may be
 * narrower than the server — every affordance it hides is a request the server
 * would have allowed, and the server re-authorizes anyway — but it must never
 * be wider, because a wider gate is a control that fails after the user commits
 * to it. Every row below runs that comparison inline, and one sweep restates
 * it over the whole matrix so deleting a row cannot delete the invariant.
 *
 * `@/lib/authz` is imported for real: it is a pure predicate module here, and
 * importing it is the whole point — a fixture restating the realm rule would
 * pass while the real gate drifted. (Its import graph is server-only, which is
 * why the COMPONENT may not import it; a test file has no such constraint, and
 * the boundary itself is pinned in `src/lib/__tests__/article-actions-gate.test.ts`.)
 */

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

/** The Clerk session the island reads — the identity half of the gate. */
const clerk = vi.hoisted(() => ({
  current: { isLoaded: true, isSignedIn: false, user: null } as {
    isLoaded: boolean;
    isSignedIn: boolean;
    user: { username?: string | null } | null;
  },
}));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => clerk.current,
  SignInButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/u/alice/transformers",
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * `ArticleView` is an async SERVER component; these are the reads it makes that
 * have no place in a jsdom run. The mock is PARTIAL on purpose — `isVaultEligible`
 * and `belongsInCommons` reach `isAgentScopedType`/`isArtifactType` through this
 * same module, and the whole point of the `ArticleView` suite below is that the
 * REAL realm predicate decides the prop.
 */
vi.mock("@/lib/wiki", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/wiki")>()),
  buildSlugTenantMap: async () => ({}),
  findBacklinks: async () => [],
  findSimilarPages: async () => [],
}));

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/** The page owner every row below uses (never the site owner). */
const OWNER = "alice";
/** `NEXT_PUBLIC_OWNER_HANDLE` for this suite — a DIFFERENT human from `OWNER`,
 *  so "page owner" and "site owner" can never be satisfied by one viewer and
 *  the two halves of the gate stay separable. */
const SITE_OWNER = "root";

interface Row {
  name: string;
  /** The page's authorization-relevant frontmatter. */
  meta: PageReadMeta;
  /** The signed-in viewer's handle, or `null` for signed out. */
  viewer: string | null;
  /** What the matrix expects on screen. */
  expectDelete: boolean;
}

const ROWS: Row[] = [
  {
    name: "owner of a public knowledge page — the realm reserves it for agents",
    meta: { owner: OWNER, visibility: "public" },
    viewer: OWNER,
    expectDelete: false,
  },
  {
    name: "owner of a public artifact — artifacts fail belongsInCommons",
    meta: { owner: OWNER, visibility: "public", type: "html" },
    viewer: OWNER,
    expectDelete: true,
  },
  {
    name: "owner of a public slides artifact",
    meta: { owner: OWNER, visibility: "public", type: "slides" },
    viewer: OWNER,
    expectDelete: true,
  },
  {
    name: "owner of a public agent-scoped page — also outside the realm",
    meta: { owner: OWNER, visibility: "public", type: "agent-knowledge" },
    viewer: OWNER,
    expectDelete: true,
  },
  {
    name: "owner of a private page — private is the owner's own",
    meta: { owner: OWNER, visibility: "private" },
    viewer: OWNER,
    expectDelete: true,
  },
  {
    name: "site owner on a realm page — an admin, so the server allows it too",
    meta: { owner: OWNER, visibility: "public" },
    viewer: SITE_OWNER,
    expectDelete: true,
  },
  {
    name: "signed-out viewer",
    meta: { owner: OWNER, visibility: "public" },
    viewer: null,
    expectDelete: false,
  },
  {
    name: "signed-in stranger on a public knowledge page",
    meta: { owner: OWNER, visibility: "public" },
    viewer: "mallory",
    expectDelete: false,
  },
  {
    name: "signed-in stranger on someone else's public artifact",
    meta: { owner: OWNER, visibility: "public", type: "html" },
    viewer: "mallory",
    expectDelete: false,
  },
  {
    name: "signed-in stranger on someone else's private page",
    meta: { owner: OWNER, visibility: "private" },
    viewer: "mallory",
    expectDelete: false,
  },
];

/** The principal `getPrincipal()` would build for `viewer`. */
function principalFor(viewer: string | null): Principal | null {
  return viewer ? ({ id: `user_${viewer}`, handle: viewer } as Principal) : null;
}

function mount(row: Row) {
  clerk.current = row.viewer
    ? { isLoaded: true, isSignedIn: true, user: { username: row.viewer } }
    : { isLoaded: true, isSignedIn: false, user: null };
  render(
    <ArticleActions
      slug="transformers"
      tenant={OWNER}
      owner={OWNER}
      contributors={[]}
      isCuratable={false}
      // The prop `ArticleView` computes server-side, computed here the same
      // way — from the predicate, not from a hand-written expectation.
      realmDeniesDelete={isRealmRestrictedWrite(row.meta, "delete")}
      hasRawSource={false}
      hasSourceUrl={false}
    />,
  );
}

function deleteButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Delete this wiki page" });
}

const savedAdmin = process.env.ADMIN_HANDLES;
const savedOwner = process.env.NEXT_PUBLIC_OWNER_HANDLE;

beforeEach(() => {
  // `ADMIN_HANDLES` must be EMPTY here: a machine with it exported would make
  // some viewer below an admin and route their row through the server's
  // allow-everything branch, quietly deleting the deny cases.
  delete process.env.ADMIN_HANDLES;
  // The one admin the browser CAN know. Both `isOwnerHandle` (client) and
  // `isAdmin` (server) read this var, which is exactly why the site-owner row
  // is the one place the two sides agree on an admin.
  process.env.NEXT_PUBLIC_OWNER_HANDLE = SITE_OWNER;
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one.
  cleanup();
  if (savedAdmin === undefined) delete process.env.ADMIN_HANDLES;
  else process.env.ADMIN_HANDLES = savedAdmin;
  if (savedOwner === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  else process.env.NEXT_PUBLIC_OWNER_HANDLE = savedOwner;
});

describe("ArticleActions — the Delete affordance against canWritePage (DW-120)", () => {
  it.each(ROWS)("$name", (row) => {
    mount(row);
    const rendered = deleteButton() !== null;
    expect(rendered).toBe(row.expectDelete);

    // THE INVARIANT, per row: the client gate is never wider than the server's
    // answer. Evaluated through the real predicate, so a change to the realm
    // rule fails here rather than shipping a button the server refuses.
    const serverAllows = canWritePage(
      row.meta,
      principalFor(row.viewer),
      "delete",
    );
    if (rendered) {
      expect(serverAllows).toBe(true);
    }
  });

  it("offers Delete to nobody the server would refuse, across the whole matrix", () => {
    // The `it.each` above asserts the inequality row by row; this restates it
    // as one sweep so a row deleted from `ROWS` cannot quietly remove the
    // invariant along with the case.
    const offeredButRefused: string[] = [];
    for (const row of ROWS) {
      mount(row);
      if (
        deleteButton() !== null &&
        !canWritePage(row.meta, principalFor(row.viewer), "delete")
      ) {
        offeredButRefused.push(row.name);
      }
      cleanup();
    }
    expect(offeredButRefused).toEqual([]);
  });

  it("is narrower than the server only where the browser cannot know better", () => {
    // The one accepted divergence: `ADMIN_HANDLES` is server-only, so an admin
    // who is NOT the site owner is refused the button while the server would
    // allow the delete. Asserted explicitly rather than left implicit, because
    // "narrower" is only acceptable in this exact direction — and because a
    // future attempt to close the gap would have to expose `ADMIN_HANDLES` to
    // the browser, which this records as the reason not to.
    process.env.ADMIN_HANDLES = "mallory";
    const meta: PageReadMeta = { owner: OWNER, visibility: "public" };
    const row: Row = { name: "", meta, viewer: "mallory", expectDelete: false };
    mount(row);

    expect(canWritePage(meta, principalFor("mallory"), "delete")).toBe(true);
    expect(deleteButton()).toBeNull();
  });

  it("hides Delete while the Clerk session is still loading", () => {
    // A page owner on a page they may delete: the affordance depends purely on
    // the session resolving, so an unloaded session must not render it — the
    // fail-closed direction.
    clerk.current = { isLoaded: false, isSignedIn: false, user: null };
    render(
      <ArticleActions
        slug="transformers"
        tenant={OWNER}
        owner={OWNER}
        contributors={[]}
        isCuratable={false}
        realmDeniesDelete={false}
        hasRawSource={false}
        hasSourceUrl={false}
      />,
    );
    expect(deleteButton()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The surface the acceptance criterion actually names
// ---------------------------------------------------------------------------

/**
 * AC-1, observed on THE ARTICLE: "given a public knowledge page and a signed-in
 * non-admin page owner, when the article renders, then no Delete control
 * appears."
 *
 * The matrix above mounts `ArticleActions` and supplies `realmDeniesDelete`
 * itself, so it proves the gate given a correct prop — and says nothing about
 * whether `ArticleView` computes that prop correctly. The other half was pinned
 * only by regexes over source text, which cannot see a wrong answer: coerce
 * `visibility` from the wrong field, pass `"body"` instead of `"delete"`, or
 * invert the boolean, and every source pin still matches while the page owner
 * is offered a Delete the server refuses. That is the DW-120 bug itself, so it
 * is pinned here against the rendered article.
 *
 * Two rows are enough, and they are chosen to straddle `belongsInCommons`: a
 * plain public page (realm-restricted) and a public `html` artifact (not). A
 * constant `true` and a constant `false` each fail exactly one of them.
 */
function articlePage(frontmatter: Frontmatter) {
  const body = "# Transformers\n\nSome prose.\n";
  return {
    slug: "transformers",
    title: "Transformers",
    path: "wiki/transformers.md",
    content: `---\nowner: ${OWNER}\n---\n${body}`,
    frontmatter,
    body,
  };
}

async function renderArticle(frontmatter: Frontmatter) {
  // A sync render of an async server component: await the element, then mount
  // what it returned. There is no test-only seam in the component itself.
  const element = await ArticleView({
    page: articlePage(frontmatter),
    slug: "transformers",
    pageTenant: OWNER,
    principal: { id: `user_${OWNER}`, handle: OWNER } as Principal,
  });
  render(element);
}

describe("ArticleView — the realm fact it computes, seen on the article (DW-120)", () => {
  beforeEach(() => {
    // The page owner is signed in and is NOT the site owner: the exact viewer
    // AC-1 describes, and the one the old gate got wrong.
    clerk.current = {
      isLoaded: true,
      isSignedIn: true,
      user: { username: OWNER },
    };
    // `RevisionHistory` fetches on mount; nothing here asserts on it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ revisions: [] }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides Delete from the page owner on a public KNOWLEDGE page", async () => {
    const frontmatter = { title: "Transformers", owner: OWNER, visibility: "public" };
    await renderArticle(frontmatter as Frontmatter);

    expect(deleteButton()).toBeNull();
    // …and the server agrees, for the same pair. Without this the assertion
    // above would also pass for a control hidden by accident.
    expect(
      canWritePage(
        { owner: OWNER, visibility: "public" },
        principalFor(OWNER),
        "delete",
      ),
    ).toBe(false);
  });

  it("still offers Delete to the owner of a public ARTIFACT on the same surface", async () => {
    // The row that fails a constant-`true` prop. An `html` artifact is public
    // but outside `belongsInCommons`, so the realm never touches it and its
    // owner keeps the control.
    const frontmatter = {
      title: "Chart",
      owner: OWNER,
      visibility: "public",
      type: "html",
    };
    await renderArticle(frontmatter as Frontmatter);

    expect(deleteButton()).not.toBeNull();
    expect(
      canWritePage(
        { owner: OWNER, visibility: "public", type: "html" },
        principalFor(OWNER),
        "delete",
      ),
    ).toBe(true);
  });
});
