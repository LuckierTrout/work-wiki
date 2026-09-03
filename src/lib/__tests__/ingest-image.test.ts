import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// LLM off — ingestImage writes a prebuilt body so the LLM is skipped anyway.
vi.mock("../llm", () => ({ hasLLMKey: vi.fn(() => false), callLLM: vi.fn() }));
// Vision is mocked (no Workers AI binding in tests).
vi.mock("../vision", () => ({ describeImage: vi.fn() }));
// Keep the real fetch module but stub the network-touching image helpers.
vi.mock("../fetch", async (orig) => {
  const actual = await orig<typeof import("../fetch")>();
  return { ...actual, fetchImageBytes: vi.fn(), storeImageBytes: vi.fn() };
});

import { ingest, ingestImage } from "../ingest";
import { hasLLMKey, callLLM } from "../llm";
import { describeImage } from "../vision";
import { fetchImageBytes, storeImageBytes } from "../fetch";
import {
  readWikiPageWithFrontmatter,
  readRawSourceById,
  rawRelPath,
  wikiRelPath,
  tenantWikiRelPath,
  tenantForOwner,
} from "../wiki";
import { parseSources } from "../sources";
import { resetSourceIndex } from "../source-index";
import { resetAliasIndex } from "../alias-index";
import { _resetStorage, getStorage } from "../storage";

const mockedDescribe = vi.mocked(describeImage);
const mockedFetchBytes = vi.mocked(fetchImageBytes);
const mockedStoreBytes = vi.mocked(storeImageBytes);
const mockedHasLLMKey = vi.mocked(hasLLMKey);
const mockedCallLLM = vi.mocked(callLLM);

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-image-"));
  for (const k of ["DATA_DIR", "WIKI_DIR", "RAW_DIR"]) saved[k] = process.env[k];
  process.env.DATA_DIR = tmpDir;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  _resetStorage(); // re-root storage at this test's fresh tmpDir (avoid cross-test bleed)
  resetSourceIndex();
  resetAliasIndex();
  vi.clearAllMocks();
  mockedFetchBytes.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]).buffer,
    filename: "photo.png",
    contentType: "image/png",
  });
  // localPath reflects the final (vision/title-derived) slug.
  mockedStoreBytes.mockImplementation(async (_bytes, slug, fname) => ({
    localPath: `assets/${slug}/${fname}`,
    filename: fname,
  }));
});

afterEach(async () => {
  for (const k of ["DATA_DIR", "WIKI_DIR", "RAW_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("ingestImage", () => {
  it("creates a page embedding the image + vision description, attributed to the owner with sourceType image", async () => {
    mockedDescribe.mockResolvedValue({ text: "A red square on white." });

    const result = await ingestImage(
      { imageUrl: "https://example.com/photo.png" },
      { author: "alice", owner: "alice", triggeredBy: "alice", title: "My Photo" },
    );

    expect(mockedFetchBytes).toHaveBeenCalledWith("https://example.com/photo.png");
    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    expect(page!.content).toContain("![My Photo](assets/my-photo/photo.png)");
    expect(page!.content).toContain("A red square on white.");
    expect(page!.frontmatter.owner).toBe("alice");
    expect(page!.frontmatter.source_url).toBe("https://example.com/photo.png");
    const sources = parseSources(page!.frontmatter.sources as string);
    expect(sources[0]?.type).toBe("image");
  });

  it("still creates an image-only page when vision is unavailable (fail-soft)", async () => {
    mockedDescribe.mockResolvedValue(null);

    const result = await ingestImage(
      { imageUrl: "https://example.com/photo.png" },
      { author: "bob", owner: "bob", title: "Diagram" },
    );

    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    expect(page!.content).toContain("![Diagram](assets/diagram/photo.png)");
    // No description paragraph, but the page exists and embeds the image.
    expect(page!.content.trim().endsWith("(assets/diagram/photo.png)")).toBe(true);
  });

  it("does not duplicate the embedded image in a ## Images section", async () => {
    mockedDescribe.mockResolvedValue({ text: "desc" });
    const result = await ingestImage(
      { imageUrl: "https://example.com/photo.png" },
      { author: "alice", owner: "alice", title: "Once" },
    );
    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    const occurrences = page!.content.split("assets/once/photo.png").length - 1;
    expect(occurrences).toBe(1);
    expect(page!.content).not.toContain("## Images");
  });

  it("titles the page from the vision text when no title is given (not the random filename)", async () => {
    mockedFetchBytes.mockResolvedValue({
      bytes: new Uint8Array([1]).buffer,
      filename: "HI6bsa_a0AAqUJC.jpeg", // random upload name
      contentType: "image/jpeg",
    });
    mockedDescribe.mockResolvedValue({
      text: "模型 + 手脚架 = 智能体\n\nA blue advertisement for an agent harness.",
    });

    const result = await ingestImage(
      { imageUrl: "https://example.com/x.jpeg" },
      { author: "alice", owner: "alice" }, // no title
    );

    // Slug derived from the transcribed first line, not "hi6bsa-a0aaqujc".
    expect(result.primarySlug).not.toBe("hi6bsa-a0aaqujc");
    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    expect(page!.content).toContain("模型 + 手脚架 = 智能体");
  });
});

describe("source images → dropped (ingest, LLM path)", () => {
  it("drops source images: body is image-free with no ## Figures; raw keeps the original refs", async () => {
    mockedHasLLMKey.mockResolvedValue(true);
    // The synthesizer is fed image-free text and returns clean prose.
    mockedCallLLM.mockResolvedValue(
      "# Doc\n\n## Summary\n\nDistilled.\n\n## Details\n\nMore.",
    );

    const result = await ingest(
      "Doc With Pics",
      "Some text.\n\n![a chart](assets/doc/chart.png)\n\nmore text.",
      { author: "alice", owner: "alice" },
    );

    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    // No gallery, and no image anywhere in the page body.
    expect(page!.content).not.toContain("## Figures");
    expect(page!.content).not.toContain("chart.png");
    // No re-hosting: source images are never fetched or stored to R2.
    expect(mockedFetchBytes).not.toHaveBeenCalled();
    expect(mockedStoreBytes).not.toHaveBeenCalled();

    // Invariant: the RAW source is untouched — it keeps the original image ref.
    const rawId = parseSources(page!.frontmatter.sources as string)[0]?.raw_id;
    const raw = await readRawSourceById(result.primarySlug, rawId!);
    expect(raw.content).toContain("![a chart](assets/doc/chart.png)");
  });

  it("no-LLM-key fallback also drops images (no gallery, body image-free)", async () => {
    mockedHasLLMKey.mockResolvedValue(false);

    const result = await ingest(
      "Doc Fallback",
      "Some prose.\n\n![a chart](assets/doc/chart.png)\n\nmore prose.",
      { author: "alice", owner: "alice" },
    );

    const page = await readWikiPageWithFrontmatter(result.primarySlug);
    expect(page!.content).not.toContain("## Figures");
    expect(page!.content).not.toContain("chart.png");
    expect(page!.content).toContain("Some prose.");
  });
});

describe("source provenance — text-paste supersession", () => {
  it("a real source URL replaces a prior text-paste placeholder of the same type", async () => {
    mockedHasLLMKey.mockResolvedValue(true);
    mockedCallLLM.mockResolvedValue("# X\n\n## Summary\n\nv1.");
    // First ingest with no URL → an x-mention source with a "text-paste" placeholder.
    await ingest("Recur Src", "version one content here", {
      sourceType: "x-mention",
      author: "a",
      owner: "a",
    });

    mockedCallLLM.mockResolvedValue("# X\n\n## Summary\n\nv2.");
    // Re-ingest (changed content) now WITH the real article URL.
    const r = await ingest("Recur Src", "version two content, changed", {
      sourceType: "x-mention",
      sourceUrl: "https://x.com/i/status/123",
      author: "a",
      owner: "a",
    });

    const page = await readWikiPageWithFrontmatter(r.primarySlug);
    const sources = parseSources(page!.frontmatter.sources as string);
    // The stale text-paste is gone; only the real URL remains.
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ type: "x-mention", url: "https://x.com/i/status/123" });
  });
});

// ---------------------------------------------------------------------------
// ingestImage — asset keys are content-addressed (DW-693)
//
// `ingestImage` mints the asset key from `slugify(title)` BEFORE calling
// `ingest()`, because the key is embedded in the body `ingest()` is handed —
// so the key is built from the PRE-uniquified slug. When `ingest()` then
// uniquifies (the realm fork off another owner's private page), the two pages
// keep pointing at ONE key, and `writeAsset` is an overwrite door: the second
// upload silently replaces the first page's image.
//
// Every other row in this file runs against the module-level
// `vi.mock("../fetch")` stub of `storeImageBytes`, which is exactly why nothing
// here ever exercised the real key. These rows restore the REAL implementation
// via `vi.importActual` and let it write to the per-test tmpdir the suite
// already roots DATA_DIR/RAW_DIR at, so the key is exercised against real
// storage at the `ingestImage` boundary rather than mocked away.
//
// Only ONE of the two rows pins the collision. The different-bytes row is the
// ABLATION — it is what fails without the digest. The identical-bytes row is an
// INVARIANT: it passes unchanged against the pre-fix code, and its job is to
// stop the fix from being "over-applied" into a per-call unique key.
// ---------------------------------------------------------------------------

describe("ingestImage — asset keys are content-addressed (DW-693)", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../fetch")>("../fetch");
    mockedStoreBytes.mockImplementation(actual.storeImageBytes);
    mockedHasLLMKey.mockResolvedValue(false);
    mockedDescribe.mockResolvedValue(null);
  });

  /** The `assets/<...>` ref the page body embeds. */
  function embeddedRef(content: string): string {
    const ref = content.match(/!\[[^\]]*\]\((assets\/[^)]+)\)/)?.[1];
    expect(ref).toBeDefined();
    return ref!;
  }

  /** Resolve that ref to stored bytes the way `/api/assets/[...path]` does. */
  async function readAssetBytes(ref: string): Promise<number[]> {
    return [...new Uint8Array(await getStorage().readAsset(rawRelPath(ref)))];
  }

  /**
   * Make the page PRIVATE so the next owner's same-titled ingest FORKS instead
   * of merging — the two-page state the collision needs. This is the realm-fork
   * guard doing its job (DW-698), which is what leaves two pages sharing one
   * pre-uniquified asset directory.
   */
  async function makePrivate(slug: string) {
    const page = await readWikiPageWithFrontmatter(slug);
    const flipped = page!.content.replace(/^visibility: .*$/m, "visibility: private");
    expect(flipped).not.toBe(page!.content);
    // Rewrite wherever the page actually landed: `ingest()` writes the owner's
    // tenant silo (plus, historically, a flat compatibility copy), and the silo
    // is what a read resolves to. Flipping only the flat copy would leave the
    // authoritative bytes public and the fork would never happen.
    const owner = String(page!.frontmatter.owner ?? "");
    const storage = getStorage();
    const paths = [
      tenantWikiRelPath(tenantForOwner(owner), `${slug}.md`),
      wikiRelPath(`${slug}.md`),
    ];
    let written = 0;
    for (const p of paths) {
      if (!(await storage.fileExists(p))) continue;
      await storage.writeFile(p, flipped);
      written++;
    }
    expect(written).toBeGreaterThan(0);
  }

  const ALICE_BYTES = [11, 22, 33, 44];
  const BOB_BYTES = [55, 66, 77, 88];

  // ABLATION row: fails with the digest removed from the stored filename. Both
  // pages then address `assets/photo/photo.png`, and `writeAsset` is an
  // overwrite door — Bob's upload replaces Alice's bytes under the key her page
  // still embeds. The assertions that catch it are `bobRef` vs `aliceRef` and
  // the two byte read-backs below it.
  it("gives two same-title, same-filename uploads with DIFFERENT bytes two different keys", async () => {
    const alice = await ingestImage(
      { bytes: new Uint8Array(ALICE_BYTES).buffer, filename: "photo.png" },
      { author: "alice", owner: "alice", title: "Photo" },
    );
    expect(alice.primarySlug).toBe("photo");
    await makePrivate("photo");

    const bob = await ingestImage(
      { bytes: new Uint8Array(BOB_BYTES).buffer, filename: "photo.png" },
      { author: "bob", owner: "bob", title: "Photo" },
    );
    // Bob's PAGE forked, but his asset directory is still `assets/photo/` —
    // minted from the title before `ingest()` uniquified. Only the digest in
    // the filename keeps the two keys apart.
    expect(bob.primarySlug).not.toBe("photo");

    const aliceRef = embeddedRef((await readWikiPageWithFrontmatter("photo"))!.content);
    const bobRef = embeddedRef(
      (await readWikiPageWithFrontmatter(bob.primarySlug))!.content,
    );

    // The page slug stays the FIRST segment — `/api/assets/[...path]` reads it
    // as the page slug to gate private images.
    expect(aliceRef.startsWith("assets/photo/")).toBe(true);
    expect(bobRef.startsWith("assets/photo/")).toBe(true);
    // Two uploads, two keys.
    expect(bobRef).not.toBe(aliceRef);
    // …and each page reads back its OWN bytes.
    expect(await readAssetBytes(aliceRef)).toEqual(ALICE_BYTES);
    expect(await readAssetBytes(bobRef)).toEqual(BOB_BYTES);
    // The extension survives, so `contentTypeFor` still answers image/png.
    expect(aliceRef.endsWith("photo.png")).toBe(true);
  });

  // INVARIANT row: passes with the digest removed too, by design — identical
  // bytes already shared one key before the fix. What it pins is that the key
  // is derived from the BYTES and nothing else: swap the digest for a random or
  // per-call token and this row fails, because two copies of one image would
  // start occupying two keys.
  it("gives two same-title, same-filename uploads with IDENTICAL bytes one shared key", async () => {
    const shared = [9, 8, 7, 6];

    const alice = await ingestImage(
      { bytes: new Uint8Array(shared).buffer, filename: "photo.png" },
      { author: "alice", owner: "alice", title: "Photo" },
    );
    await makePrivate("photo");

    const bob = await ingestImage(
      { bytes: new Uint8Array(shared).buffer, filename: "photo.png" },
      { author: "bob", owner: "bob", title: "Photo" },
    );
    expect(bob.primarySlug).not.toBe(alice.primarySlug);

    const aliceRef = embeddedRef((await readWikiPageWithFrontmatter("photo"))!.content);
    const bobRef = embeddedRef(
      (await readWikiPageWithFrontmatter(bob.primarySlug))!.content,
    );

    // Content-addressed: same bytes, same key — and it holds those bytes.
    expect(bobRef).toBe(aliceRef);
    expect(await readAssetBytes(aliceRef)).toEqual(shared);
  });
});
