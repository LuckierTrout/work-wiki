import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { patchMetadata, PATCHABLE_KEYS } from "../patch-metadata";
import { ensureDirectories, writeWikiPage } from "../wiki";
import { serializeFrontmatter } from "../frontmatter";
import { resetAliasIndex } from "../alias-index";
import { listThreads, RECONCILE_THREAD_TITLE } from "../talk";
import { WRITE_DENIAL, resolveWriteDenial } from "../write-denial";

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

async function seedPage(slug: string, owner?: string): Promise<void> {
  const content = serializeFrontmatter(
    {
      title: "Test Page",
      created: "2025-01-01",
      updated: "2025-01-01",
      confidence: 0.5,
      visibility: "public",
      authors: ["tester"],
      ...(owner ? { owner } : {}),
    },
    "# Test Page\n\nSome content.\n",
  );
  await writeWikiPage(slug, content);
}

// ===========================================================================
// visibility guard
// ===========================================================================

describe("patchMetadata — visibility guard", () => {
  it("lets the owner set visibility: private with no plan (billing is retired)", async () => {
    await seedPage("guarded-page", "alice");
    const result = await patchMetadata({
      slug: "guarded-page",
      metadata: { visibility: "private" },
      principal: { id: "u_alice", handle: "alice" },
    });
    expect(result.updated).toBe(true);
  });

  it("still rejects a NON-owner setting visibility: private (NOT_OWNER)", async () => {
    await seedPage("someone-elses-page", "alice");
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
      // The page here is PUBLIC, so the ACL admits the metadata patch and it is
      // the guard below it that refuses — pinned by its sentence, so a later
      // change that made the ACL fire instead would surface as a different
      // message rather than as an identical-looking pass.
      expect(e.message).toBe("Only the page owner can make it private.");
      // And it says nothing about the commons realm, which is not what refused
      // this and never can be (see the suite below).
      expect(e.message).not.toMatch(/public knowledge/i);
    }
  });

  it("allows visibility: public", async () => {
    await seedPage("public-page");
    const result = await patchMetadata({
      slug: "public-page",
      metadata: { visibility: "public" },
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
// write-ACL denial copy (DW-122)
// ===========================================================================

/**
 * `patchMetadata`'s ACL denial, and why it stays GENERIC by construction.
 *
 * Every other write door routes its refusal through `resolveWriteDenial`, and
 * on a public knowledge page that resolver answers the commons-realm
 * explanation. This door routes through the same resolver — but passes
 * `writeKind: "metadata"`, and `canWritePage`'s realm branch gates only `body`
 * and `delete`. So the realm can never be what refuses a metadata patch, and
 * the generic sentence is produced by the predicate rather than by this call
 * site remembering to omit the realm copy.
 *
 * That is asserted two ways here, because the branch itself is currently
 * UNREACHABLE end-to-end and a test pretending otherwise would be fiction:
 * `canWriteFrontmatter(fm, p)` (metadata) returns false only for a private page
 * `p` cannot read — and for exactly those pages `canReadFrontmatter` is false
 * too, so control goes to the NOT_FOUND cloak instead. The invariant is
 * therefore pinned at the resolver call the site makes, plus the outcome a
 * caller can actually observe.
 */
describe("patchMetadata — the ACL denial sentence", () => {
  it("resolves to the GENERIC sentence for the arguments this site passes", () => {
    // The exact call `patch-metadata.ts` makes on a public knowledge page —
    // the one page class that WOULD earn the realm explanation at any body or
    // delete door. `"metadata"` is what keeps it generic. (`owner` is omitted:
    // the realm predicate reads `visibility` and `type` only, and the resolver
    // types its parameter to exactly those two.)
    const publicKnowledge = { visibility: "public" };
    expect(resolveWriteDenial("edit", publicKnowledge, "metadata")).toBe(
      WRITE_DENIAL.edit,
    );
    // The contrast that gives the line above its meaning: same page, same
    // action, a realm-gated write kind.
    expect(resolveWriteDenial("edit", publicKnowledge, "body")).not.toBe(
      WRITE_DENIAL.edit,
    );
  });

  it("cloaks a non-owner patching another user's PRIVATE page, with no realm wording", async () => {
    // The observable half: the case that fails `canWriteFrontmatter` takes the
    // NOT_FOUND cloak, never the NOT_OWNER sentence — which is precisely why
    // the NOT_OWNER branch is unreachable today.
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

  it("keeps PUBLIC pages collectively patchable, so no denial fires at all", async () => {
    // The positive that bounds the two negatives above: the realm gates body
    // and delete, NOT metadata, so a non-owner really can patch a public
    // knowledge page's metadata. If this ever starts throwing, the "generic by
    // construction" argument above is what needs revisiting.
    await seedPage("shared-knowledge", "alice");
    const result = await patchMetadata({
      slug: "shared-knowledge",
      metadata: { confidence: 0.9 },
      principal: { id: "u_bob", handle: "bob" },
    });
    expect(result.updated).toBe(true);
  });
});

// ===========================================================================
// disputed → reconciliation thread
// ===========================================================================

describe("patchMetadata — disputed transition", () => {
  it("opens a reconciliation thread when disputed transitions false→true", async () => {
    await seedPage("dispute-page");

    // Page starts without disputed flag — patch it to disputed: true.
    const result = await patchMetadata({
      slug: "dispute-page",
      metadata: { disputed: true },
      author: "reviewer",
    });
    expect(result.updated).toBe(true);

    // A reconciliation thread should now exist.
    const threads = await listThreads("dispute-page");
    const reconcileThread = threads.find(
      (t) => t.title === RECONCILE_THREAD_TITLE && t.status === "open",
    );
    expect(reconcileThread).toBeDefined();
    expect(reconcileThread!.comments[0].body).toContain(
      "flagged disputed via metadata patch",
    );
  });

  it("does NOT open a thread when patching an already-disputed page", async () => {
    // Seed a page that is already disputed.
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

    // Patch an unrelated field — should NOT open a reconciliation thread.
    await patchMetadata({
      slug: "already-disputed",
      metadata: { confidence: 0.3 },
      author: "editor",
    });

    const threads = await listThreads("already-disputed");
    const reconcileThread = threads.find(
      (t) => t.title === RECONCILE_THREAD_TITLE,
    );
    expect(reconcileThread).toBeUndefined();
  });
});
