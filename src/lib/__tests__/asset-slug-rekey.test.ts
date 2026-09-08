import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { rekeyForkedPageAssets } from "../asset-slug-rekey";
import { writeWikiPageWithSideEffects } from "../lifecycle";
import { _resetLocks } from "../lock";
import { _resetStorage, getStorage } from "../storage";
import {
  ensureDirectories,
  rawRelPath,
  readWikiPage,
  serializeFrontmatter,
  tenantForOwner,
  tenantRawRelPath,
  type Frontmatter,
} from "../wiki";

// ---------------------------------------------------------------------------
// DW-738 — the one-time repair for directories a realm fork already mis-keyed.
//
// `ingestImage` mints an image's storage key from `slugify(title)` before
// `ingest()` settles the slug, so a page forked to `<base>-<n>` was left
// embedding `assets/<base>/…`. `/api/assets/[...path]` reads that first segment
// as the page slug, so it gated the forked page's own image on the OTHER page's
// visibility, and `syncSiloForPage` mirrored the bytes into the other owner's
// tenant. The ingest path re-keys at the source now; this repairs what a
// deployment already holds.
//
// Real tmpdir storage on purpose: the migration's whole job is to move bytes
// between keys and rewrite the page that references them, and a mocked storage
// would let it "pass" without either happening.
// ---------------------------------------------------------------------------

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "asset-slug-rekey-"));
  for (const key of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[key] = process.env[key];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  await ensureDirectories();
});

afterEach(async () => {
  for (const key of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetLocks();
  _resetStorage();
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const ALICE_FILE = "aaaa1111-photo.png";
const BOB_FILE = "bbbb2222-photo.png";
const ALICE_BYTES = [11, 22, 33];
const BOB_BYTES = [44, 55, 66];

async function writeAsset(ref: string, bytes: number[]): Promise<void> {
  await getStorage().writeAsset(rawRelPath(ref), new Uint8Array(bytes).buffer);
}

async function assetExists(ref: string): Promise<boolean> {
  return getStorage().fileExists(rawRelPath(ref));
}

async function assetBytes(ref: string): Promise<number[]> {
  return [...new Uint8Array(await getStorage().readAsset(rawRelPath(ref)))];
}

async function seedPage(
  slug: string,
  body: string,
  owner?: string,
): Promise<void> {
  // Frontmatter only when an owner matters to the case: `IndexEntry.owner` is
  // what the migration's tenant arm resolves a silo from, and a page without
  // one exercises the "no tenant to mirror into" branch.
  const content = owner
    ? serializeFrontmatter(
        {
          created: "2020-01-01",
          updated: "2020-01-01",
          owner,
          visibility: "public",
          authors: [owner],
          contributors: [],
          confidence: 0.7,
          expiry: "2099-01-01",
          tags: [],
          disputed: false,
        } as Frontmatter,
        `# ${slug}\n\n${body}\n`,
      )
    : `# ${slug}\n\n${body}\n`;
  await writeWikiPageWithSideEffects({
    slug,
    title: slug,
    content,
    summary: slug,
    logOp: "ingest",
    crossRefSource: null,
    author: owner ?? "test",
  });
}

/** The tenant-silo mirror address `syncSiloForPage` writes for one ref. */
function tenantAsset(owner: string, ref: string): string {
  return tenantRawRelPath(tenantForOwner(owner), ref);
}

/**
 * The state a fork left behind: `photo` (the base page) and `photo-2` (the
 * forked one) both embedding refs under `assets/photo/`.
 */
async function seedMiskeyedFork(): Promise<void> {
  await seedPage("photo", `![photo](assets/photo/${ALICE_FILE})`);
  await seedPage("photo-2", `![photo](assets/photo/${BOB_FILE})`);
  await writeAsset(`assets/photo/${ALICE_FILE}`, ALICE_BYTES);
  await writeAsset(`assets/photo/${BOB_FILE}`, BOB_BYTES);
}

describe("rekeyForkedPageAssets", () => {
  it("moves the forked page's asset onto its own slug and rewrites the body", async () => {
    await seedMiskeyedFork();

    expect(await rekeyForkedPageAssets()).toBe(1);

    const forked = await readWikiPage("photo-2", { fresh: true });
    expect(forked!.content).toContain(`assets/photo-2/${BOB_FILE}`);
    expect(forked!.content).not.toContain(`assets/photo/${BOB_FILE}`);
    // The bytes moved, unchanged, and the pre-fork key is reclaimed — nothing
    // is left in the base page's directory pointing at the forked page's image.
    expect(await assetBytes(`assets/photo-2/${BOB_FILE}`)).toEqual(BOB_BYTES);
    expect(await assetExists(`assets/photo/${BOB_FILE}`)).toBe(false);

    // The base page is untouched in every respect.
    const base = await readWikiPage("photo", { fresh: true });
    expect(base!.content).toContain(`assets/photo/${ALICE_FILE}`);
    expect(await assetBytes(`assets/photo/${ALICE_FILE}`)).toEqual(ALICE_BYTES);
  });

  it("is idempotent — a second run re-keys nothing", async () => {
    await seedMiskeyedFork();
    expect(await rekeyForkedPageAssets()).toBe(1);

    // The rewrite left the body pointing at `assets/photo-2/…`, which no longer
    // matches the pattern, so the migration self-terminates. This is what makes
    // it safe on the scan's every-pass schedule.
    expect(await rekeyForkedPageAssets()).toBe(0);

    const forked = await readWikiPage("photo-2", { fresh: true });
    expect(await assetBytes(`assets/photo-2/${BOB_FILE}`)).toEqual(BOB_BYTES);
    expect(forked!.content).toContain(`assets/photo-2/${BOB_FILE}`);
  });

  it("copies but does NOT delete a key the base page still references", async () => {
    // Identical uploads share a content-addressed key, so the forked page's ref
    // can name bytes the base page also embeds. Removing it would be data loss;
    // the copy is enough.
    await seedPage("photo", `![photo](assets/photo/${ALICE_FILE})`);
    await seedPage("photo-2", `![photo](assets/photo/${ALICE_FILE})`);
    await writeAsset(`assets/photo/${ALICE_FILE}`, ALICE_BYTES);

    expect(await rekeyForkedPageAssets()).toBe(1);

    expect(await assetBytes(`assets/photo-2/${ALICE_FILE}`)).toEqual(ALICE_BYTES);
    expect(await assetExists(`assets/photo/${ALICE_FILE}`)).toBe(true);
    const base = await readWikiPage("photo", { fresh: true });
    expect(base!.content).toContain(`assets/photo/${ALICE_FILE}`);
  });

  it("never touches the SHARED `assets/illustrations/` cache", async () => {
    // That first segment is a fixed directory naming no page, and the bakery
    // puts a public URL to it inside saved answers and slides. Re-keying it
    // would break every one of those references.
    await seedPage("illustrations", "the page that happens to share the name");
    await seedPage(
      "illustrations-2",
      "![yoyo](assets/illustrations/abc123.jpg)",
    );
    await writeAsset("assets/illustrations/abc123.jpg", [7, 7, 7]);

    expect(await rekeyForkedPageAssets()).toBe(0);

    expect(await assetBytes("assets/illustrations/abc123.jpg")).toEqual([7, 7, 7]);
    expect(await assetExists("assets/illustrations-2/abc123.jpg")).toBe(false);
    const page = await readWikiPage("illustrations-2", { fresh: true });
    expect(page!.content).toContain("assets/illustrations/abc123.jpg");
  });

  it("leaves a `<base>-<n>` page alone when no page `<base>` exists", async () => {
    // Only the uniquifier's own shape is in scope: a numeric suffix is a
    // perfectly ordinary slug (`gpt-4`, `q-2024`), and without a base page
    // there was no fork to repair.
    await seedPage("release-2", `![r](assets/release/${BOB_FILE})`);
    await writeAsset(`assets/release/${BOB_FILE}`, BOB_BYTES);

    expect(await rekeyForkedPageAssets()).toBe(0);
    expect(await assetExists(`assets/release/${BOB_FILE}`)).toBe(true);
    expect(await assetExists(`assets/release-2/${BOB_FILE}`)).toBe(false);
  });

  it("moves the tenant-silo mirror too, not just the flat key", async () => {
    // The half a flat-only repair leaves behind. The Workbench and `/api/v1`
    // file doors read the TENANT raw root and gate `raw/assets/<base>/…` on the
    // base page, so a forked image still sitting in the base owner's silo is
    // still listed and downloadable by the wrong owner — while the forked owner
    // never gains the bytes in their own tenant at all.
    const { syncSiloForPage } = await import("../silo");
    await seedPage("photo", `![photo](assets/photo/${ALICE_FILE})`, "alice");
    await seedPage("photo-2", `![photo](assets/photo/${BOB_FILE})`, "bob");
    await writeAsset(`assets/photo/${ALICE_FILE}`, ALICE_BYTES);
    await writeAsset(`assets/photo/${BOB_FILE}`, BOB_BYTES);

    // The state a deployment that already ran the tenant migration is in: both
    // files mirrored into ALICE's silo, because both were keyed on her slug.
    await syncSiloForPage("photo", tenantForOwner("alice"));
    await syncSiloForPage("photo-2", tenantForOwner("bob"));
    const storage = getStorage();
    expect(
      await storage.fileExists(tenantAsset("alice", `assets/photo/${BOB_FILE}`)),
    ).toBe(true);

    expect(await rekeyForkedPageAssets()).toBe(1);

    // Bob's tenant gained his own key…
    expect(
      await storage.fileExists(
        tenantAsset("bob", `assets/photo-2/${BOB_FILE}`),
      ),
    ).toBe(true);
    // …and Alice's silo no longer serves his image off her slug.
    expect(
      await storage.fileExists(tenantAsset("alice", `assets/photo/${BOB_FILE}`)),
    ).toBe(false);
    // Her OWN mirrored asset is untouched — the tenant delete follows the flat
    // reclamation, which never fires for a key she still references.
    expect(
      await storage.fileExists(
        tenantAsset("alice", `assets/photo/${ALICE_FILE}`),
      ),
    ).toBe(true);
  });

  it("reclaims NOTHING when any page body could not be read", async () => {
    // The delete guard asks "does any page still reference this key?", and it
    // can only answer from the bodies it actually read. A page skipped by the
    // fail-soft read contributes no refs, which is indistinguishable from a
    // page that references nothing — so one unreadable body disarms the whole
    // reclamation phase rather than letting it delete bytes a page embeds.
    await seedMiskeyedFork();
    await seedPage("bystander", `![b](assets/photo/${BOB_FILE})`);

    const storage = getStorage();
    const readFile = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (target: string) => {
      if (target.includes("bystander")) throw new Error("R2 unavailable");
      return readFile(target);
    });

    // The copy and the rewrite still happen — they are safe under uncertainty.
    expect(await rekeyForkedPageAssets()).toBe(1);
    expect(await assetBytes(`assets/photo-2/${BOB_FILE}`)).toEqual(BOB_BYTES);
    // The delete does not.
    expect(await assetExists(`assets/photo/${BOB_FILE}`)).toBe(true);
  });

  it("re-keys a real ref while leaving a URL and a NESTED path that merely contain `assets/<base>/`", async () => {
    // Both false-positive shapes, and both are seeded so the bytes behind them
    // genuinely EXIST — otherwise the copy would simply throw and the per-ref
    // fail-soft would mask a scanner that had no business matching them.
    //
    //   - `assets/photo/<file>` inside an absolute URL is somebody else's CDN
    //     path. A scanner without the leading-delimiter guard copies it and
    //     rewrites the link to `assets/photo-2/…`, breaking it.
    //   - `assets/photo/sub/f.png` is a NESTED path. Without the trailing
    //     boundary the pattern backtracks into the "file" `sub` and moves that.
    const url = `https://cdn.example.com/assets/photo/${ALICE_FILE}`;
    const nested = "assets/photo/sub/f.png";
    await seedPage("photo", `![photo](assets/photo/${ALICE_FILE})`);
    await seedPage(
      "photo-2",
      `![photo](assets/photo/${BOB_FILE})\n\nSee ${url} and ${nested}.`,
    );
    await writeAsset(`assets/photo/${ALICE_FILE}`, ALICE_BYTES);
    await writeAsset(`assets/photo/${BOB_FILE}`, BOB_BYTES);
    await writeAsset("assets/photo/sub", [1]);

    // Exactly ONE asset moves: the real ref.
    expect(await rekeyForkedPageAssets()).toBe(1);

    const forked = await readWikiPage("photo-2", { fresh: true });
    expect(forked!.content).toContain(`assets/photo-2/${BOB_FILE}`);
    expect(await assetBytes(`assets/photo-2/${BOB_FILE}`)).toEqual(BOB_BYTES);
    // The URL and the nested path are byte-identical, and neither was copied.
    expect(forked!.content).toContain(url);
    expect(forked!.content).toContain(nested);
    expect(await assetExists(`assets/photo-2/${ALICE_FILE}`)).toBe(false);
    expect(await assetExists("assets/photo-2/sub")).toBe(false);
    expect(await assetExists("assets/photo/sub")).toBe(true);
  });

  it("skips only the REF whose bytes are missing, still repairing the one beside it", async () => {
    // Per-ref, not per-page. A ref to bytes nobody stored fails
    // DETERMINISTICALLY, so abandoning the whole page would leave the genuinely
    // mis-keyed ref beside it broken on every future scan — and would strand
    // the copy already made for it.
    await seedPage("photo", `![photo](assets/photo/${ALICE_FILE})`);
    await seedPage(
      "photo-2",
      `![a](assets/photo/missing.png) ![b](assets/photo/${BOB_FILE})`,
    );
    await writeAsset(`assets/photo/${ALICE_FILE}`, ALICE_BYTES);
    await writeAsset(`assets/photo/${BOB_FILE}`, BOB_BYTES);

    expect(await rekeyForkedPageAssets()).toBe(1);

    const forked = await readWikiPage("photo-2", { fresh: true });
    // The good ref moved and the page was written…
    expect(forked!.content).toContain(`assets/photo-2/${BOB_FILE}`);
    expect(await assetBytes(`assets/photo-2/${BOB_FILE}`)).toEqual(BOB_BYTES);
    // …while the dangling one is left exactly as it was, not invented at the
    // new key.
    expect(forked!.content).toContain("assets/photo/missing.png");
    expect(await assetExists("assets/photo-2/missing.png")).toBe(false);
  });

  it("answers 0 on an empty deployment", async () => {
    expect(await rekeyForkedPageAssets()).toBe(0);
  });
});
