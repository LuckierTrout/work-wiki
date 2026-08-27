import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { patchMetadata, PATCHABLE_KEYS } from "../patch-metadata";
import type { Principal } from "../auth";
import {
  beginPageCache,
  ensureDirectories,
  readWikiPage,
  readWikiPageWithFrontmatter,
  writeWikiPage,
  wikiRelPath,
} from "../wiki";
import { withDurableLock } from "../lock";
import { getStorage } from "../storage";
import { serializeFrontmatter } from "../frontmatter";
import { resetAliasIndex } from "../alias-index";
import { listThreads } from "../talk";
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
    expect(await listThreads("dispute-page")).toEqual([]);
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

    expect(await listThreads("already-disputed")).toEqual([]);
  });
});


// ===========================================================================
// The merge base is the STORED file, read strictly (DW-379)
// ===========================================================================

/**
 * `patchMetadata` rebuilds the page from the bytes it read and passes them as
 * `expectedContent`, so that read is the merge base. `pageCache` is
 * module-global and ref-counted around bulk scans: a scan can be holding a
 * superseded entry open when a PATCH arrives, and a cached read would merge the
 * new frontmatter into a body that is no longer stored. `strict` is the other
 * half — without it a non-ENOENT storage failure reads back as `null` and the
 * `NOT_FOUND` throw below tells the caller their page is gone (a 404) when it
 * is only unreadable, and a retry against the same blip would keep saying so.
 */
describe("patchMetadata — fresh + strict merge base", () => {
  it("merges into the STORED body while a stale page cache is open", async () => {
    const slug = "patch-cached";
    // The `html` type is NOT about the HTML-artifact guards — this row never
    // reaches one. It is the same fixture convention the visibility-guard block
    // above documents: `belongsInCommons` excludes artifacts, so the realm gate
    // (DW-121) stays out of the way and the MERGE BASE is the live term. Seeded
    // as a plain public knowledge page, the ACL refuses the patch outright and
    // this row would never exercise the read it exists to pin.
    await seedPage(slug, "alice", "html");
    const cleanup = beginPageCache();
    try {
      // A concurrent scan populates the cache.
      const cached = (await readWikiPage(slug))!;

      // The file moves underneath it. Written DIRECTLY through storage, so
      // nothing invalidates — a stale entry is exactly what this row is about.
      const stored = cached.content.replace(
        "Some content.",
        "Owner's newer body.",
      );
      expect(stored).not.toBe(cached.content);
      // `wikiRelPath` (not a suffix match) is deliberate HERE: this write CREATES
      // the condition and must land on the exact path the seeded flat Page
      // occupies. The read spies below match by suffix instead, because they
      // must follow the Page wherever it resolves.
      await getStorage().writeFile(wikiRelPath(`${slug}.md`), stored);
      // The cache is genuinely stale: a cached read still serves the old bytes.
      expect((await readWikiPage(slug))!.content).toBe(cached.content);

      await patchMetadata({
        slug,
        metadata: { confidence: 0.9 },
        principal: { id: "u_alice", handle: "alice" },
      });

      // THE ASSERTION: without the fresh read the merge base is the cached
      // copy, and the patch writes back a body that had already been replaced.
      const after = (await readWikiPageWithFrontmatter(slug, {
        fresh: true,
        strict: true,
      }))!;
      expect(after.body).toContain("Owner's newer body.");
      expect(after.body).not.toContain("Some content.");
      expect(after.frontmatter.confidence).toBe(0.9);
    } finally {
      cleanup();
    }
  });

  it("throws the storage failure instead of writing, and does not call it NOT_FOUND", async () => {
    const slug = "patch-blip";
    // Same artifact fixture as the row above, for the same realm-gate reason —
    // kept identical so the two rows differ only in the failure they inject.
    await seedPage(slug, "alice", "html");
    const storedPath = wikiRelPath(`${slug}.md`);
    const before = await getStorage().readFile(storedPath);

    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    const readSpy = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (filePath) => {
        // Matched by SUFFIX, not by `wikiRelPath` (the flat compatibility
        // path): a Page that is silo-primary lives at a different prefix, and
        // an equality check would quietly stop intercepting the read under test
        // — leaving this row green for the wrong reason.
        if (filePath.endsWith(`${slug}.md`)) {
          throw new Error("storage unavailable");
        }
        return originalRead(filePath);
      });

    try {
      const err = await patchMetadata({
        slug,
        metadata: { confidence: 0.9 },
        principal: { id: "u_alice", handle: "alice" },
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("storage unavailable");
      // NOT the absent-page throw: `NOT_FOUND` is what the PATCH route's status
      // ladder turns into a 404. A blip has to fall through to its 500.
      expect((err as NodeJS.ErrnoException).code).not.toBe("NOT_FOUND");
      expect((err as Error).message).not.toContain("page not found");
    } finally {
      readSpy.mockRestore();
    }

    // Nothing was written.
    expect(await getStorage().readFile(storedPath)).toBe(before);
  });

  it("still throws NOT_FOUND for a slug that genuinely has no stored file", async () => {
    // The companion the PUT and revert suites both carry. `strict` must not
    // convert a real absence into a storage error: `NOT_FOUND` is the code the
    // PATCH route's status ladder maps to 404, and only ENOENT may reach it.
    const err = await patchMetadata({
      slug: "patch-never-existed",
      metadata: { confidence: 0.9 },
      principal: { id: "u_alice", handle: "alice" },
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect((err as NodeJS.ErrnoException).code).toBe("NOT_FOUND");
    expect((err as Error).message).toBe("page not found: patch-never-existed");
  });
});

describe("patchMetadata — concurrent Page edits", () => {
  it("refuses a stale metadata rebuild instead of restoring the old body", async () => {
    const slug = "metadata-race";
    await seedPage(slug, "alice", "html");
    const storage = getStorage();
    const target = wikiRelPath(`${slug}.md`);
    const originalRead = storage.readFile.bind(storage);
    let sawInitialRead!: () => void;
    const initialRead = new Promise<void>((resolve) => { sawInitialRead = resolve; });
    const readSpy = vi.spyOn(storage, "readFile").mockImplementation(async (filePath) => {
      const content = await originalRead(filePath);
      if (filePath === target) sawInitialRead();
      return content;
    });

    let patch!: Promise<unknown>;
    await withDurableLock(`page-lifecycle:${slug}`, async () => {
      patch = patchMetadata({
        slug,
        metadata: { confidence: 0.9 },
        principal: { id: "u_alice", handle: "alice" },
      });
      await initialRead;
      const current = await readWikiPageWithFrontmatter(slug, { fresh: true, strict: true });
      await writeWikiPage(
        slug,
        serializeFrontmatter(current!.frontmatter, "# Test Page\n\nOwner's newer body.\n"),
      );
    });

    await expect(patch).rejects.toMatchObject({ name: "LifecyclePageConflictError" });
    expect((await readWikiPageWithFrontmatter(slug, { fresh: true, strict: true }))!.body)
      .toContain("Owner's newer body.");
    readSpy.mockRestore();
  });
});
