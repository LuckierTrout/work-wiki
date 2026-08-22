import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { patchMetadata, PATCHABLE_KEYS } from "../patch-metadata";
import type { Principal } from "../auth";
import {
  beginPageCache,
  ensureDirectories,
  readWikiPageWithFrontmatter,
  writeWikiPage,
} from "../wiki";
import { serializeFrontmatter } from "../frontmatter";
import { resetAliasIndex } from "../alias-index";
import { readDiscussThreads } from "./discuss-fixture";
import {
  WRITE_DENIAL,
  WRITE_DENIAL_REALM,
  resolveWriteDenial,
} from "../write-denial";

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "patch-meta-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  await ensureDirectories();
});

afterEach(async () => {
  if (originalWikiDir === undefined) {
    delete process.env.WIKI_DIR;
  } else {
    process.env.WIKI_DIR = originalWikiDir;
  }
  if (originalRawDir === undefined) {
    delete process.env.RAW_DIR;
  } else {
    process.env.RAW_DIR = originalRawDir;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
  resetAliasIndex();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedPage(
  slug: string,
  owner?: string,
  type?: string,
): Promise<void> {
  const content = serializeFrontmatter(
    {
      title: "Test Page",
      created: "2025-01-01",
      updated: "2025-01-01",
      confidence: 0.5,
      visibility: "public",
      authors: ["tester"],
      ...(owner ? { owner } : {}),
      ...(type ? { type } : {}),
    },
    "# Test Page\n\nSome content.\n",
  );
  await writeWikiPage(slug, content);
}

// ===========================================================================
// visibility guard
// ===========================================================================

/**
 * The owner-only `visibility: private` guard sits BELOW the write ACL, so every
 * case here seeds a public `html` ARTIFACT rather than a plain public page.
 * `belongsInCommons` excludes artifacts, so the realm gate (DW-121) is out of
 * the way and OWNERSHIP — the thing this guard is about — is the live term. On
 * a public KNOWLEDGE page the ACL above now refuses both principals with the
 * realm sentence, which would make these cases pass for the wrong reason.
 */
describe("patchMetadata — visibility guard", () => {
  it("lets the owner set visibility: private with no plan (billing is retired)", async () => {
    await seedPage("guarded-page", "alice", "html");
    const result = await patchMetadata({
      slug: "guarded-page",
      metadata: { visibility: "private" },
      principal: { id: "u_alice", handle: "alice" },
    });
    expect(result.updated).toBe(true);
  });

  it("still rejects a NON-owner setting visibility: private (NOT_OWNER)", async () => {
    await seedPage("someone-elses-page", "alice", "html");
    try {
      await patchMetadata({
        slug: "someone-elses-page",
        metadata: { visibility: "private" },
        principal: { id: "u_bob", handle: "bob" },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      expect(e.code).toBe("NOT_OWNER");
      // WHICH `NOT_OWNER`. `patchMetadata` throws that code from two places:
      // the write-ACL cloak near the top, and this owner-only visibility guard.
      // The page here is an ARTIFACT, so the ACL admits the metadata patch and
      // it is the guard below it that refuses — pinned by its sentence, so a
      // later change that made the ACL fire instead would surface as a
      // different message rather than as an identical-looking pass.
      expect(e.message).toBe("Only the page owner can make it private.");
      // And it says nothing about the commons realm, which is not what refused
      // this: an artifact is outside `belongsInCommons` entirely.
      expect(e.message).not.toMatch(/public knowledge/i);
    }
  });

  it("allows visibility: public", async () => {
    // A plain public knowledge page, patched by the service principal — which
    // is who the realm reserves it for. The guard only fires on `private`.
    await seedPage("public-page");
    const result = await patchMetadata({
      slug: "public-page",
      metadata: { visibility: "public" },
      principal: { id: "service:test", handle: "yoyo" },
    });
    expect(result.updated).toBe(true);
    expect(result.slug).toBe("public-page");
  });

  it("includes visibility in PATCHABLE_KEYS", () => {
    expect(PATCHABLE_KEYS.has("visibility")).toBe(true);
  });

  it("still rejects lifecycle keys alongside private visibility", async () => {
    await seedPage("combo-page");
    // lifecycle rejection fires before visibility guard
    try {
      await patchMetadata({
        slug: "combo-page",
        metadata: { created: "2025-06-01", visibility: "private" },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      expect(e.code).toBe("LIFECYCLE_FIELD");
    }
  });
});

// ===========================================================================
// write-ACL denial copy (DW-122, DW-121)
// ===========================================================================

/**
 * `patchMetadata`'s ACL denial, and why it now names the REALM.
 *
 * It used to be the one write door whose sentence stayed generic by
 * construction: it passes `writeKind: "metadata"`, and `canWritePage`'s realm
 * branch gated only `body` and `delete`, so the resolver could never answer the
 * realm explanation here. That asymmetry was the DW-121 defect — the only UI
 * that reaches a metadata patch is the edit page, which refuses the WHOLE screen
 * on `"body"`, so the collective metadata loop the ACL described had no surface.
 *
 * The realm is kind-independent now, which makes this door an ordinary member
 * of the set: its cloak takes every unreadable page, a READABLE private page is
 * writable by exactly the principals that could read it, so readable + denied
 * implies the realm — and the sentence says so. The NOT_OWNER branch is
 * REACHABLE at last, and the cases below drive it end to end rather than pinning
 * the resolver call in isolation.
 */
describe("patchMetadata — the ACL denial sentence", () => {
  const savedAdmin = process.env.ADMIN_HANDLES;
  const savedOwner = process.env.NEXT_PUBLIC_OWNER_HANDLE;
  beforeEach(() => {
    // Either var exported on the machine running this would make the principals
    // below admins and turn every deny into a silent 200.
    delete process.env.ADMIN_HANDLES;
    delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  });
  afterEach(() => {
    if (savedAdmin === undefined) delete process.env.ADMIN_HANDLES;
    else process.env.ADMIN_HANDLES = savedAdmin;
    if (savedOwner === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
    else process.env.NEXT_PUBLIC_OWNER_HANDLE = savedOwner;
  });

  it("resolves to the REALM sentence for the arguments this site passes", () => {
    // The exact call `patch-metadata.ts` makes on a public knowledge page.
    // `"metadata"` used to be what kept it generic; since DW-121 it earns the
    // same explanation every body and delete door answers. (`owner` is omitted:
    // the realm predicate reads `visibility` and `type` only, and the resolver
    // types its parameter to exactly those two.)
    const publicKnowledge = { visibility: "public" };
    expect(resolveWriteDenial("edit", publicKnowledge, "metadata")).toBe(
      WRITE_DENIAL_REALM.edit,
    );
    // The contrast that gives the line above its meaning: a page OUTSIDE the
    // realm keeps the generic sentence, so this is a fact about the page rather
    // than a table this site reads unconditionally.
    expect(
      resolveWriteDenial("edit", { visibility: "public", type: "html" }, "metadata"),
    ).toBe(WRITE_DENIAL.edit);
  });

  it("refuses a NON-owner patching a public knowledge page, and says why", async () => {
    await seedPage("shared-knowledge", "alice");
    try {
      await patchMetadata({
        slug: "shared-knowledge",
        metadata: { confidence: 0.9 },
        principal: { id: "u_bob", handle: "bob" },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      expect(e.code).toBe("NOT_OWNER");
      expect(e.message).toBe(WRITE_DENIAL_REALM.edit);
    }
  });

  it("refuses the PAGE OWNER too — the realm is not an ownership rule", async () => {
    // The case DW-121 is really about. Alice owns this page and the old ACL let
    // her patch its metadata, while the edit page — the only screen that offers
    // the toggle — refused her outright. The API agrees with the screen now.
    await seedPage("alice-knowledge", "alice");
    try {
      await patchMetadata({
        slug: "alice-knowledge",
        metadata: { confidence: 0.9 },
        principal: { id: "u_alice", handle: "alice" },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      expect(e.code).toBe("NOT_OWNER");
      expect(e.message).toBe(WRITE_DENIAL_REALM.edit);
    }
  });

  it("still lets the service principal and an admin patch the same page", async () => {
    // The realm reserves public knowledge for agents and admins — it does not
    // freeze it. Both halves of that "who can still do it" clause are exercised,
    // because a gate that refused them too would satisfy every deny above.
    await seedPage("agent-knowledge-page", "alice");
    expect(
      (
        await patchMetadata({
          slug: "agent-knowledge-page",
          metadata: { confidence: 0.8 },
          principal: { id: "service:mcp", handle: "yoyo" },
        })
      ).updated,
    ).toBe(true);

    process.env.ADMIN_HANDLES = "carol";
    expect(
      (
        await patchMetadata({
          slug: "agent-knowledge-page",
          metadata: { confidence: 0.7 },
          principal: { id: "u_carol", handle: "carol" },
        })
      ).updated,
    ).toBe(true);
  });

  it("keeps patching pages OUTSIDE the realm — an artifact its owner owns", async () => {
    // The positive that bounds the denies: `belongsInCommons` excludes rendered
    // artifacts, so the realm never touches them and their owner still patches
    // metadata. Without this, a gate that simply refused every patch would pass
    // every case above.
    const content = serializeFrontmatter(
      {
        title: "Chart",
        created: "2025-01-01",
        visibility: "public",
        type: "html",
        owner: "alice",
      },
      "# Chart\n\nRendered.\n",
    );
    await writeWikiPage("alice-chart", content);

    const result = await patchMetadata({
      slug: "alice-chart",
      metadata: { confidence: 0.9 },
      principal: { id: "u_alice", handle: "alice" },
    });
    expect(result.updated).toBe(true);
  });

  it("cloaks a non-owner patching another user's PRIVATE page, with no realm wording", async () => {
    // The read cloak stays FIRST, and this is what makes the realm sentence
    // above provable: an unreadable page takes the NOT_FOUND branch, never the
    // NOT_OWNER one, so a page that reaches the realm sentence was always
    // readable by the caller who is told about it.
    const content = serializeFrontmatter(
      {
        title: "Alice Secret",
        created: "2025-01-01",
        visibility: "private",
        owner: "alice",
      },
      "# Alice Secret\n\nPrivate.\n",
    );
    await writeWikiPage("alice-secret-meta", content);

    try {
      await patchMetadata({
        slug: "alice-secret-meta",
        metadata: { confidence: 0.9 },
        principal: { id: "u_bob", handle: "bob" },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      expect(e.code).toBe("NOT_FOUND");
      expect(e.message).toBe("page not found: alice-secret-meta");
      // The cloak must read like a missing page — no realm, no hint that the
      // page exists or what kind of page it is.
      expect(e.message).not.toMatch(/public knowledge/i);
      expect(e.message).not.toMatch(/agent-maintained/i);
    }
  });
});

// ===========================================================================
// disputed transition — no reconciliation thread (DW-230)
// ===========================================================================

/**
 * A `disputed` transition used to auto-open a talk reconciliation thread from
 * here (and from ingest and merge). The talk HTTP surfaces are retired, so no
 * surface could read it: the write produced a discuss file nobody would ever
 * see, on a page whose `disputed` frontmatter already says the same thing where
 * a reader can find it. Both cases below now pin the ABSENCE, so a reintroduced
 * writer fails rather than passing unnoticed.
 *
 * The patches run as the service principal because the realm gate (DW-121)
 * refuses a human's metadata patch on a public knowledge page — the write has to
 * actually land for "…and no thread was written" to mean anything.
 */
const SERVICE: Principal = { id: "service:test", handle: "yoyo" };

describe("patchMetadata — disputed transition", () => {
  it("writes the page but opens NO thread when disputed goes false→true", async () => {
    await seedPage("dispute-page");

    const result = await patchMetadata({
      slug: "dispute-page",
      metadata: { disputed: true },
      author: "reviewer",
      principal: SERVICE,
    });
    expect(result.updated).toBe(true);

    // The write itself is unchanged — the flag is set where a reader sees it.
    const page = await readWikiPageWithFrontmatter("dispute-page");
    expect(page!.frontmatter.disputed).toBe(true);
    // …and nothing was written to the discussion store.
    expect(await readDiscussThreads("dispute-page")).toEqual([]);
  });

  it("opens no thread when patching an already-disputed page either", async () => {
    const content = serializeFrontmatter(
      {
        title: "Already Disputed",
        created: "2025-01-01",
        updated: "2025-01-01",
        confidence: 0.5,
        disputed: true,
        visibility: "public",
        authors: ["tester"],
      },
      "# Already Disputed\n\nContent.\n",
    );
    await writeWikiPage("already-disputed", content);

    await patchMetadata({
      slug: "already-disputed",
      metadata: { confidence: 0.3 },
      author: "editor",
      principal: SERVICE,
    });

    expect(await readDiscussThreads("already-disputed")).toEqual([]);
  });
});

// ===========================================================================
// The merge base is the STORED file, not a cached one (DW-379)
// ===========================================================================

describe("patchMetadata — a stale page cache is open", () => {
  it("folds the patch into the STORED file, not the cached copy", async () => {
    // `pageCache` is module-global and ref-counted around bulk scans
    // (`lint.ts`, `search.ts`, `query.ts`, `dataview.ts`), so one can be
    // holding a superseded entry open when a PATCH arrives. Merging into that
    // entry re-serializes a body and a frontmatter that are no longer stored —
    // silently reverting whatever was saved in between, with the patch riding
    // on top as if nothing had happened.
    await seedPage("pm-stale");
    const cleanup = beginPageCache();
    try {
      // A concurrent scan populates the cache.
      const cached = (await readWikiPageWithFrontmatter("pm-stale"))!;
      expect(cached.body).toContain("Some content.");

      // Another actor saves. Written DIRECTLY, past `writeWikiPage` — which
      // invalidates — because a STALE entry is exactly what this row is about.
      // (In production the same state arises from a scan that re-read the entry
      // after an invalidation.)
      const stored = serializeFrontmatter(
        { ...cached.frontmatter, tags: ["kept-by-the-other-actor"] },
        "# Test Page\n\nWhat the other actor stored, LATER.\n",
      );
      await fs.writeFile(cached.path, stored, "utf-8");
      // The cache is genuinely stale: a cached read still serves the old bytes.
      expect((await readWikiPageWithFrontmatter("pm-stale"))!.body).toContain(
        "Some content.",
      );

      await patchMetadata({
        slug: "pm-stale",
        metadata: { confidence: 0.9 },
        author: "editor",
        principal: SERVICE,
      });

      // The patch landed on the LATER bytes: both the body it re-serialized and
      // the frontmatter it merged into are the stored ones. Without the fresh
      // read the cached copy is written back and the other actor's save is gone.
      const after = (await readWikiPageWithFrontmatter("pm-stale", {
        fresh: true,
      }))!;
      expect(after.body).toContain("What the other actor stored, LATER.");
      expect(after.frontmatter.tags).toEqual(["kept-by-the-other-actor"]);
      expect(after.frontmatter.confidence).toBe(0.9);
    } finally {
      cleanup();
    }
  });
});
