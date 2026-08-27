/**
 * Tests that the POST /api/wiki/[slug]/revisions revert route correctly passes
 * the authenticated principal's handle as `author` through the write pipeline.
 *
 * Covers issue #500:
 * - Revision sidecar carries the reverter's handle
 * - Service principal fallback works for service-token reverts
 * - Contributor index reflects the reverter's edit
 *
 * And DW-379/DW-378, the revert's MERGE BASE — the page read whose bytes the
 * route hands on as `expectedContent`:
 * - A non-ENOENT storage failure on that read answers 5xx, not `page not found`
 * - The revert lands against the STORED file while a stale `pageCache` entry
 *   is open, not against the superseded cached copy
 * - A slug with no stored file still answers 404 (`strict` does not turn a real
 *   absence into a server error)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// ---------------------------------------------------------------------------
// Mock auth before any imports that transitively pull it in
// ---------------------------------------------------------------------------
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => ({ id: "user-1", handle: "alice" })),
  getServicePrincipal: vi.fn(() => null),
}));

import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import {
  ensureDirectories,
  writeWikiPage,
  wikiRelPath,
  beginPageCache,
  readWikiPage,
} from "../wiki";
import { listRevisions, readRevisionMeta } from "../revisions";
import {
  getContributorIndex,
  rebuildContributorIndex,
} from "../contributor-index";
import { _resetStorage, getStorage } from "../storage";
import { _resetLocks } from "../lock";
import { serializeFrontmatter } from "../frontmatter";

const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedGetServicePrincipal = vi.mocked(getServicePrincipal);

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------
let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "revert-attr-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  await ensureDirectories();

  // Reset mocks to defaults
  mockedGetPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });
  mockedGetServicePrincipal.mockReturnValue(null);
});

afterEach(async () => {
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a page with frontmatter so the revert route can read it.
 *  Defaults to private so the mocked owner can body-write (commons pages
 *  block human body writes after the realm gate). */
async function seedPage(slug: string, body: string, owner = "alice") {
  const fm = { title: slug, created: "2025-01-01", updated: "2025-01-01", owner, visibility: "private" };
  const content = serializeFrontmatter(fm, body);
  await writeWikiPage(slug, content);
}

/** Call the POST revert route handler. */
async function callRevert(slug: string, timestamp: number) {
  const { POST } = await import("@/app/api/wiki/[slug]/revisions/route");
  const req = new Request("http://localhost:3000/api/wiki/" + slug + "/revisions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "revert", timestamp }),
  });
  return POST(req, { params: Promise.resolve({ slug }) });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/wiki/[slug]/revisions — revert attribution", () => {
  it("revision sidecar carries the authenticated user's handle as author", async () => {
    // Seed a page with initial content, then overwrite to create a revision.
    await seedPage("attr-test", "# Attr Test\n\nOriginal content.");
    // Overwrite to create a revision snapshot of the original.
    await writeWikiPage(
      "attr-test",
      serializeFrontmatter(
        { title: "attr-test", created: "2025-01-01", updated: "2025-01-02", owner: "alice", visibility: "private" },
        "# Attr Test\n\nUpdated content.",
      ),
    );

    // The revision of the original should now exist.
    const revisions = await listRevisions("attr-test");
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    const oldTimestamp = revisions[0].timestamp;

    // Revert as "alice"
    mockedGetPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });
    const res = await callRevert("attr-test", oldTimestamp);
    expect(res.status).toBe(200);

    // The revert creates a new revision (snapshot of the content before revert).
    // Check the newest revision sidecar for the author.
    const postRevisions = await listRevisions("attr-test");
    expect(postRevisions.length).toBeGreaterThan(revisions.length);
    const newestTs = postRevisions[0].timestamp;

    const meta = await readRevisionMeta("attr-test", newestTs);
    expect(meta).not.toBeNull();
    expect(meta!.author).toBe("alice");
  });

  it("revision sidecar carries the service principal's handle when no session", async () => {
    // No Clerk session → getPrincipal returns null, service token resolves.
    mockedGetPrincipal.mockResolvedValue(null);
    mockedGetServicePrincipal.mockReturnValue({ id: "service:bot", handle: "bot" });

    // Seed + overwrite to create a revision.
    await seedPage("svc-test", "# Svc Test\n\nOriginal.");
    await writeWikiPage(
      "svc-test",
      serializeFrontmatter(
        { title: "svc-test", created: "2025-01-01", updated: "2025-01-02", owner: "bot" },
        "# Svc Test\n\nUpdated.",
      ),
    );

    const revisions = await listRevisions("svc-test");
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    const oldTimestamp = revisions[0].timestamp;

    const res = await callRevert("svc-test", oldTimestamp);
    expect(res.status).toBe(200);

    const postRevisions = await listRevisions("svc-test");
    const newestTs = postRevisions[0].timestamp;
    const meta = await readRevisionMeta("svc-test", newestTs);
    expect(meta).not.toBeNull();
    expect(meta!.author).toBe("bot");
  });

  it("contributor index reflects the reverter's edit", async () => {
    // Seed + overwrite.
    await seedPage("contrib-test", "# Contrib Test\n\nOriginal.");
    await writeWikiPage(
      "contrib-test",
      serializeFrontmatter(
        { title: "contrib-test", created: "2025-01-01", updated: "2025-01-02", owner: "alice", visibility: "private" },
        "# Contrib Test\n\nUpdated.",
      ),
    );

    // Bootstrap a contributor index so recordEditForAuthor has something to update.
    await rebuildContributorIndex();

    const revisions = await listRevisions("contrib-test");
    const oldTimestamp = revisions[0].timestamp;

    // Grab pre-revert state.
    const priorIdx = await getContributorIndex();
    const priorEdit = priorIdx?.authors["alice"]?.editCount ?? 0;

    // Revert as "alice"
    mockedGetPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });
    const res = await callRevert("contrib-test", oldTimestamp);
    expect(res.status).toBe(200);

    // The contributor index should have incremented alice's edit count.
    const updatedIdx = await getContributorIndex();
    expect(updatedIdx).not.toBeNull();
    const postEdit = updatedIdx!.authors["alice"]?.editCount ?? 0;
    expect(postEdit).toBeGreaterThan(priorEdit);
    expect(updatedIdx!.authors["alice"]?.pagesEdited).toContain("contrib-test");
  });
});

// ---------------------------------------------------------------------------
// The revert's merge base is FRESH + STRICT (DW-379)
// ---------------------------------------------------------------------------

/**
 * The route reads the page before it reverts and hands those bytes to
 * `writeWikiPageWithSideEffects` as `expectedContent` — so that read is the
 * revert's merge base, and it has to be the STORED file. `strict` is the other
 * half: without it a non-ENOENT storage failure reads back as `null`, the
 * `!existing` branch calls it `page not found`, and a transient blip tells the
 * owner the page they are looking at has been deleted.
 */
describe("POST /api/wiki/[slug]/revisions — merge-base read failures", () => {
  it("answers 5xx — NOT `page not found` — when the page read blips", async () => {
    await seedPage("revert-blip", "# Revert Blip\n\nOriginal content.");
    await writeWikiPage(
      "revert-blip",
      serializeFrontmatter(
        {
          title: "revert-blip",
          created: "2025-01-01",
          updated: "2025-01-02",
          owner: "alice",
          visibility: "private",
        },
        "# Revert Blip\n\nUpdated content.",
      ),
    );
    const revisions = await listRevisions("revert-blip");
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    const oldTimestamp = revisions[0].timestamp;

    const storage = getStorage();
    const target = wikiRelPath("revert-blip.md");
    const before = await storage.readFile(target);
    const originalRead = storage.readFile.bind(storage);
    const readSpy = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (filePath: string) => {
        // A non-ENOENT failure: the file is there, the provider is not.
        // Matched by SUFFIX rather than against `wikiRelPath` (the flat
        // compatibility path), so the spy follows the Page if it ever becomes
        // silo-primary. An equality check would silently stop intercepting the
        // read under test and leave this row green for the wrong reason.
        if (filePath.endsWith("revert-blip.md")) {
          throw new Error("storage unavailable");
        }
        return originalRead(filePath);
      });

    try {
      const res = await callRevert("revert-blip", oldTimestamp);
      expect(res.status).toBeGreaterThanOrEqual(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("storage unavailable");
      expect(body.error).not.toContain("page not found");
    } finally {
      readSpy.mockRestore();
    }

    // Nothing was written.
    expect(await getStorage().readFile(target)).toBe(before);
  });

  it("reverts against the STORED file while a stale page cache is open", async () => {
    await seedPage("revert-cached", "# Revert Cached\n\nOriginal content.");
    await writeWikiPage(
      "revert-cached",
      serializeFrontmatter(
        {
          title: "revert-cached",
          created: "2025-01-01",
          updated: "2025-01-02",
          owner: "alice",
          visibility: "private",
        },
        "# Revert Cached\n\nUpdated content.",
      ),
    );
    const revisions = await listRevisions("revert-cached");
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    const oldTimestamp = revisions[0].timestamp;

    const cleanup = beginPageCache();
    try {
      // A concurrent bulk scan populates the cache...
      const cached = (await readWikiPage("revert-cached"))!;

      // ...and the file then moves underneath it. Written DIRECTLY through
      // storage, so nothing invalidates the entry.
      // `wikiRelPath` (not a suffix match) is deliberate HERE: this write
      // CREATES the stale-cache condition and must land on the exact path the
      // seeded flat Page occupies. The read spy above matches by suffix
      // instead, because it must follow the Page wherever it resolves.
      const target = wikiRelPath("revert-cached.md");
      const stored = cached.content.replace(
        "Updated content.",
        "Newer content.",
      );
      expect(stored).not.toBe(cached.content);
      await getStorage().writeFile(target, stored);
      // The cache is genuinely stale.
      expect((await readWikiPage("revert-cached"))!.content).toBe(cached.content);

      // A cached merge base would hand `expectedContent` bytes that are no
      // longer stored, and the conditional write would refuse this revert as a
      // conflict against a save nobody made.
      const res = await callRevert("revert-cached", oldTimestamp);
      expect(res.status).toBe(200);

      const after = await getStorage().readFile(target);
      expect(after).toContain("Original content.");
    } finally {
      cleanup();
    }
  });

  it("still answers 404 for a slug that genuinely has no stored file", async () => {
    // `strict` must not turn a real absence into a 500 — ENOENT stays `null`,
    // so the 404 means only what it claims.
    const res = await callRevert("revert-never-existed", 1735689600000);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "page not found: revert-never-existed",
    });
  });
});
