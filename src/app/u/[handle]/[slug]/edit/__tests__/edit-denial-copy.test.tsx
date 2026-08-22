/**
 * DW-7 — the edit page's denial copy.
 *
 * `canWritePage`'s realm gate (`src/lib/authz.ts`) is pinned by
 * `src/lib/__tests__/authz.test.ts`; what nothing pinned was the one surface a
 * human actually hits when that gate denies them. The copy there used to be a
 * bare "You don't have write access to this page", which named neither the
 * reason nor a way forward. This renders the real server component through the
 * real `authz` predicate — only the two inputs it cannot have here
 * (`getPrincipal`, the page read) and the client editor are mocked — so the
 * explanation is asserted against the branch that produces it, not grepped.
 *
 * Reachability, for why the copy may speak in absolutes: `canReadFrontmatter`
 * runs first, so an unreadable private page already returned "Page not found",
 * and a READABLE private page is writable by exactly the principals that could
 * read it. PUBLIC agent-scoped and artifact pages fail `belongsInCommons` and
 * fall through to the public `return true` (private ones take the private-owner
 * branch instead, like any other private page). The denial branch is therefore
 * reached only for a plain public knowledge page and a non-service, non-admin
 * caller — which is why the copy names that class outright rather than
 * hedging. Both halves of that argument are pinned below, the read cloak
 * included, since the copy is only true while the ordering holds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const principal = vi.hoisted(() => ({
  current: null as { id: string; handle: string } | null,
}));
const page = vi.hoisted(() => ({
  current: null as {
    title: string;
    /** The WHOLE stored file, YAML block included — what the version hashes. */
    content: string;
    body: string;
    frontmatter: Record<string, unknown>;
  } | null,
}));

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => principal.current),
}));

vi.mock("@/lib/wiki", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/wiki")>()),
  readWikiPageWithFrontmatter: vi.fn(async () => page.current),
}));

// The editor is a client component with its own dependency tree; the denial
// branch returns before it renders. It is stubbed as a SENTINEL rather than
// `() => null` so the writable cases can assert a positive: rendering nothing
// would make "no denial screen" equally true of a "Page not found" render, an
// empty render, or a throw — none of which is the branch under test.
//
// The stub also RECORDS its props. `readOnly` is a deployment fact only this
// server component can read, and the seam that carries it is one JSX attribute:
// delete it and the editor silently falls back to `false`, letting the owner
// rewrite a page the routes will refuse (DW-37/DW-149). Mounted tests of the
// editor cannot see that seam, because they hand the prop in themselves.
const editorProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock("@/components/WikiEditor", () => ({
  WikiEditor: (props: Record<string, unknown>) => {
    editorProps.current = props;
    return <div data-testid="wiki-editor" />;
  },
}));

/**
 * `permanentRedirect` is a CONTROL-FLOW throw in Next: it never returns, and
 * the framework catches the thrown digest upstream. Rendering here has no such
 * upstream, so the redirect is captured instead of escaping as a test failure —
 * and captured as a RECORDED TARGET, because DW-123 is about which URL the 308
 * points at, not merely that one happened.
 *
 * The module is mocked wholesale rather than partially: `next/navigation`'s
 * real entry point is a client/server dual export whose other members this
 * page never touches, and a partial mock would drag them into a jsdom run for
 * nothing.
 */
const redirected = vi.hoisted(() => ({ to: [] as string[] }));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
    this.name = "RedirectSignal";
  }
}

vi.mock("next/navigation", () => ({
  permanentRedirect: (url: string) => {
    redirected.to.push(url);
    throw new RedirectSignal(url);
  },
  redirect: (url: string) => {
    redirected.to.push(url);
    throw new RedirectSignal(url);
  },
  notFound: () => {
    throw new Error("notFound()");
  },
}));

import EditWikiPage from "../page";
import { contentVersion } from "@/lib/write-precondition";
import { WRITE_DENIAL_REALM } from "@/lib/write-denial";

/**
 * The realm explanation, matched across whitespace: JSX joins the source lines
 * of this sentence with single spaces, so a pure re-wrap of the JSX changes no
 * rendered output and must not turn this suite red.
 */
const REALM_REASON = /public\s+knowledge\s+pages\s+are\s+agent-maintained/i;

/** A plain public knowledge page: `belongsInCommons` is true for it. */
const publicPage = {
  title: "Transformers",
  // `content` and `body` are two different strings on a real page, and the
  // write precondition is derived from the FIRST — `PUT /api/wiki/[slug]`
  // checks it against `existing.content` (DW-38, DW-51). A fixture that made
  // them equal would let the two sides drift without failing anything.
  content: "---\nowner: alice\n---\n\n# Transformers\n",
  body: "# Transformers\n",
  frontmatter: { owner: "alice", visibility: "public" },
};

async function renderEditPage(handle = "alice"): Promise<string> {
  const element = await EditWikiPage({
    params: Promise.resolve({ handle, slug: "transformers" }),
  });
  return renderToStaticMarkup(element);
}

/**
 * Render and report the 308 instead of the markup. Returns `null` when the page
 * rendered normally, so "no redirect" is a value a test can assert rather than
 * the absence of a throw.
 */
async function renderExpectingRedirect(handle: string): Promise<string | null> {
  try {
    await renderEditPage(handle);
    return null;
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
}

const savedAdmin = process.env.ADMIN_HANDLES;
const savedOwner = process.env.NEXT_PUBLIC_OWNER_HANDLE;

const savedReadOnly = process.env.YOPEDIA_READONLY;

beforeEach(() => {
  // Neither var may leak in: either one would make the principal an admin and
  // route every case below through the writable branch.
  delete process.env.ADMIN_HANDLES;
  delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  // A machine with this exported would otherwise make every case below assert
  // against a read-only deployment.
  delete process.env.YOPEDIA_READONLY;
  editorProps.current = null;
  redirected.to = [];
  principal.current = { id: "user_alice", handle: "alice" };
  page.current = publicPage;
});

afterEach(() => {
  // No `cleanup()` here, unlike the convention `vitest.setup.dom.ts` states:
  // this suite renders with `renderToStaticMarkup` and never mounts into the
  // document, so there is no tree to unmount. Env restore is the whole teardown.
  if (savedAdmin === undefined) delete process.env.ADMIN_HANDLES;
  else process.env.ADMIN_HANDLES = savedAdmin;
  if (savedOwner === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  else process.env.NEXT_PUBLIC_OWNER_HANDLE = savedOwner;
  if (savedReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
  else process.env.YOPEDIA_READONLY = savedReadOnly;
});

describe("edit page — the read-only seam (DW-37, DW-149)", () => {
  it("tells the editor the deployment refuses writes", async () => {
    // `isReadOnly()` reads the variable at call time, so flipping it here is
    // enough — no module reset needed.
    process.env.YOPEDIA_READONLY = "1";
    process.env.ADMIN_HANDLES = "alice";

    const html = await renderEditPage();

    // The writable branch rendered (the editor is on screen)…
    expect(html).toContain('data-testid="wiki-editor"');
    // …and it was told what the routes behind Save will do. Without this the
    // owner rewrites a whole page and meets the 403 only at Save.
    expect(editorProps.current?.readOnly).toBe(true);
  });

  it("says nothing of the sort on an ordinary deployment", async () => {
    process.env.ADMIN_HANDLES = "alice";

    const html = await renderEditPage();

    expect(html).toContain('data-testid="wiki-editor"');
    expect(editorProps.current?.readOnly).toBe(false);
  });
});

describe("edit page — the write-precondition seam (DW-38, DW-51)", () => {
  it("hands the editor the version of the WHOLE stored file", async () => {
    process.env.ADMIN_HANDLES = "alice";

    await renderEditPage();

    // The same string `PUT /api/wiki/[slug]` hashes `existing.content` into —
    // NOT the body the textarea is seeded with. This is the one seam that
    // carries it, and a mounted test of the editor cannot see it, because it
    // hands the prop in itself.
    expect(editorProps.current?.initialVersion).toBe(
      contentVersion(publicPage.content),
    );
    expect(editorProps.current?.initialVersion).not.toBe(
      contentVersion(publicPage.body),
    );
  });

  it("seeds that version from a CACHE-BYPASSING read (DW-195)", async () => {
    process.env.ADMIN_HANDLES = "alice";

    await renderEditPage();

    // `pageCache` is module-global and ref-counted around bulk scans, so one
    // can be holding a superseded entry open when this screen renders. Seeding
    // `initialVersion` from that entry hands the editor a version of bytes that
    // are no longer stored, and the owner's first save is refused 412 against a
    // write nobody made. `{ fresh: true }` is the whole of the fix, and this
    // one argument is the only place it appears on this screen.
    const { readWikiPageWithFrontmatter } = await import("@/lib/wiki");
    expect(vi.mocked(readWikiPageWithFrontmatter)).toHaveBeenCalledWith(
      "transformers",
      { fresh: true },
    );
  });
});

describe("edit page — denial copy for a public knowledge page", () => {
  it("explains that public knowledge pages are agent-maintained rather than just refusing", async () => {
    const html = await renderEditPage();

    expect(html).toContain("Cannot edit");
    // The reason: the page's realm, not a generic lack of access. The claim is
    // scoped to public KNOWLEDGE pages — public artifacts and agent-scoped
    // pages are human-editable in this same editor (pinned below).
    expect(html).toMatch(REALM_REASON);
    // Who can change it — a way forward instead of a dead end.
    expect(html).toMatch(/site admin/i);
    // The superseded copy must not survive anywhere on the screen.
    expect(html).not.toMatch(/don.{0,8}t have write access/i);
    // The mirror of the writable cases' positive: the refusal must REPLACE the
    // editor, not render alongside it.
    expect(html).not.toContain('data-testid="wiki-editor"');
  });

  it("keeps the escape route back to the page", async () => {
    const html = await renderEditPage();

    expect(html).toContain("Back to page");
    expect(html).toContain('href="/u/alice/transformers"');
    expect(html).not.toContain('data-testid="wiki-editor"');
  });

  // The copy's absolute claim ("This page is public knowledge") holds only
  // because the read cloak runs FIRST: an unreadable private page never reaches
  // the denial branch. Pinned here so a reorder fails as a test rather than as a
  // screen that misstates a private page's realm to someone who cannot read it.
  it("cloaks an unreadable private page as missing, never as a public one", async () => {
    page.current = {
      ...publicPage,
      frontmatter: { owner: "bob", visibility: "private" },
    };
    const html = await renderEditPage();

    expect(html).toContain("Page not found");
    expect(html).not.toContain("Cannot edit");
    expect(html).not.toMatch(REALM_REASON);
    expect(html).not.toContain('data-testid="wiki-editor"');
  });

  it("does not show the denial screen to an admin, who may rewrite the same page", async () => {
    process.env.ADMIN_HANDLES = "alice";
    const html = await renderEditPage();

    expect(html).not.toContain("Cannot edit");
    expect(html).not.toMatch(REALM_REASON);
    // Positive: the editor branch actually rendered, so the two negatives above
    // are the gate opening rather than a not-found or empty render.
    expect(html).toContain('data-testid="wiki-editor"');
  });

  it("does not show the denial screen on a private page its owner can write", async () => {
    page.current = {
      ...publicPage,
      frontmatter: { owner: "alice", visibility: "private" },
    };
    const html = await renderEditPage();

    expect(html).not.toContain("Cannot edit");
    expect(html).toContain('data-testid="wiki-editor"');
  });

  // The docblock's reachability argument — that agent-scoped and artifact pages
  // fail `belongsInCommons` and fall through to the writable branch — is what
  // makes the copy say "public KNOWLEDGE pages" instead of "public pages". These
  // pin it, so a later widening of the copy fails here instead of shipping a
  // claim that is false for the public pages a human CAN edit.
  // Type strings come from `isAgentScopedType` / `isArtifactType`
  // (`src/lib/page-types.ts`): any `agent-` prefix; `html` or `slides`.
  it.each(["agent-knowledge", "agent-identity", "html", "slides"])(
    "lets a human edit a public %s page — it is outside the realm gate",
    async (type) => {
      page.current = {
        ...publicPage,
        frontmatter: { owner: "alice", visibility: "public", type },
      };
      const html = await renderEditPage();

      expect(html).not.toContain("Cannot edit");
      expect(html).not.toMatch(/agent-maintained/i);
      expect(html).toContain('data-testid="wiki-editor"');
    },
  );
});

/**
 * DW-123 — the ORDER the three gates run in: read cloak → canonical 308 →
 * write denial.
 *
 * The denial branch used to run BEFORE the handle-canonicalization redirect, so
 * `/u/bob/transformers/edit` for alice's page rendered a refusal whose
 * "← Back to page" link pointed at `/u/alice/transformers` — a screen naming a
 * handle that was not the one in the address bar, and a URL the viewer never
 * asked for. Moving the denial after the 308 makes every rendered refusal
 * belong to the URL it was served from.
 *
 * The read cloak must NOT move with it. It stays first because the 308 leaks
 * the canonical owner in a `Location` header: run before the cloak, a viewer
 * who cannot read a private page would learn whose it is (and that it exists)
 * from the redirect alone. So the ordering is pinned from both sides — the 308
 * must beat the denial, and the cloak must beat the 308.
 */
describe("edit page — gate ordering on a non-canonical handle (DW-123)", () => {
  it("308s a realm-denied page to the canonical edit URL instead of refusing", async () => {
    // The exact bug: alice's public knowledge page, opened at bob's handle by a
    // non-admin. Before the reorder this rendered "Cannot edit".
    expect(await renderExpectingRedirect("bob")).toBe("/u/alice/transformers/edit");
    expect(redirected.to).toEqual(["/u/alice/transformers/edit"]);
  });

  it("still refuses on the CANONICAL url, with a back-link to that same handle", async () => {
    const html = await renderEditPage("alice");

    expect(redirected.to).toEqual([]);
    expect(html).toContain("Cannot edit");
    expect(html).toMatch(REALM_REASON);
    // The back-link belongs to the URL the viewer is on — which, after the 308
    // above, is the only URL this screen is ever served from.
    expect(html).toContain('href="/u/alice/transformers"');
  });

  it("cloaks an unreadable private page BEFORE any redirect could name its owner", async () => {
    // bob's private page, opened by alice at bob's handle. Not-found, and — the
    // part that matters — no 308: a redirect here would be an existence oracle
    // whether or not the body said "Page not found".
    page.current = {
      ...publicPage,
      frontmatter: { owner: "bob", visibility: "private" },
    };
    const html = await renderEditPage("bob");

    expect(html).toContain("Page not found");
    expect(redirected.to).toEqual([]);
    expect(html).not.toMatch(REALM_REASON);
  });

  it("cloaks it at a THIRD handle too, where the 308 would be the only tell", async () => {
    // `/u/carol/transformers/edit` for bob's private page: the requested handle
    // matches neither the owner nor the viewer, so a canonicalizing 308 would
    // hand over the owner's identity with nothing else on screen to do it.
    page.current = {
      ...publicPage,
      frontmatter: { owner: "bob", visibility: "private" },
    };
    const html = await renderEditPage("carol");

    expect(html).toContain("Page not found");
    expect(redirected.to).toEqual([]);
  });

  it("308s a WRITABLE page from a non-canonical handle, as it always did", async () => {
    // The reorder must not have moved the redirect itself: the writable path
    // still canonicalizes before rendering the editor.
    process.env.ADMIN_HANDLES = "alice";
    expect(await renderExpectingRedirect("bob")).toBe("/u/alice/transformers/edit");
    expect(editorProps.current).toBeNull();
  });

  it("renders the editor, not a redirect, once the handle is canonical", async () => {
    process.env.ADMIN_HANDLES = "alice";
    const html = await renderEditPage("alice");

    expect(redirected.to).toEqual([]);
    expect(html).toContain('data-testid="wiki-editor"');
  });
});

/**
 * DW-122 — the refusal on this screen and the refusal behind Save are ONE
 * sentence.
 *
 * The screen used to spell its paragraph inline while the nine server denies
 * answered a generic "You don't have permission to …", so the same refusal read
 * two ways depending on whether the owner opened the editor or hit the route.
 * Sourcing the paragraph from `write-denial.ts` is what makes that impossible;
 * this pins that it is actually sourced, not merely similar.
 */
describe("edit page — the denial paragraph is the shared one", () => {
  it("renders the realm sentence the server routes answer, verbatim", async () => {
    const html = await renderEditPage();

    // React escapes `&` `<` `>` `"` `'` in text; the sentence's typographic
    // apostrophes and em dash pass through unchanged, so an exact substring
    // match is the right assertion here.
    expect(html).toContain(WRITE_DENIAL_REALM.edit);
    // And the table's sentence really is the realm explanation, not a generic
    // one that happens to be shared.
    expect(WRITE_DENIAL_REALM.edit).toMatch(REALM_REASON);
  });
});
