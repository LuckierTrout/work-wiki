import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { syncSiloForPage, removeSiloForPage, reconcileSilos } from "../silo";
import { writeWikiPage, ensureDirectories, updateIndex } from "../wiki";
import { getStorage, _resetStorage } from "../storage";
import { listWorkbenchFilePaths } from "../workbench-files";
import { deleteWikiPage } from "../lifecycle";
import { _resetLocks } from "../lock";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "silo-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  _resetLocks();
  await ensureDirectories();
});

afterEach(async () => {
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("syncSiloForPage", () => {
  it("mirrors the page md into tenants/<tenant>/wiki", async () => {
    await writeWikiPage("alpha", "# Alpha\n\nBody.");
    const n = await syncSiloForPage("alpha", "alice");
    expect(n).toBe(1); // just the wiki md (no raw/revisions/discuss/assets)
    expect(await getStorage().readFile("tenants/alice/wiki/alpha.md")).toContain(
      "# Alpha",
    );
  });

  it("re-copies the mutable md but SKIPS already-mirrored immutable revisions", async () => {
    await writeWikiPage("beta", "# Beta\n\nv1");
    // Plant two immutable revision files (as saveRevision would).
    await getStorage().writeFile("wiki/.revisions/beta/1.md", "# Beta\n\nv0");
    await getStorage().writeFile(
      "wiki/.revisions/beta/1.meta.json",
      '{"author":"a"}',
    );

    // First sync copies md + both revision files.
    expect(await syncSiloForPage("beta", "bob")).toBe(3);

    // Second sync (no new revisions) copies ONLY the mutable md again — the two
    // already-mirrored revisions are skipped (the O(N) re-copy fix).
    expect(await syncSiloForPage("beta", "bob")).toBe(1);

    // A newly-added revision IS picked up next sync.
    await getStorage().writeFile("wiki/.revisions/beta/2.md", "# Beta\n\nv1");
    expect(await syncSiloForPage("beta", "bob")).toBe(2); // md + the new revision
  });

  it("mirrors a Source from raw/sources/, and removes it again (Story 2.1)", async () => {
    // Sources moved under `raw/sources/` when Workbench Intake landed. This sync
    // knew only the flat `raw/<slug>.md` address, so every ingest whose snapshot
    // went to the new one mirrored the page and silently left the Source behind
    // — and the Files tab reads `raw/` silo-only (DW-40), so "silently left
    // behind" means "not there at all" from the owner's side.
    await writeWikiPage("delta", "# Delta\n\nBody.");
    await getStorage().writeFile("raw/sources/delta.md", "the source bytes");

    // Two copies: the page md and the Source beside it.
    expect(await syncSiloForPage("delta", "alice")).toBe(2);
    expect(
      await getStorage().readFile("tenants/alice/raw/sources/delta.md"),
    ).toBe("the source bytes");

    // And the removal knows the same address. A delete that missed it would
    // leave a Source in the silo for a page that no longer exists — visible in
    // Files, with nothing to open from the other tab.
    await removeSiloForPage("delta", "alice");
    expect(
      await getStorage().fileExists("tenants/alice/raw/sources/delta.md"),
    ).toBe(false);
    expect(await getStorage().fileExists("tenants/alice/wiki/delta.md")).toBe(false);
  });

  it("still mirrors a pre-move Source from the flat raw root", async () => {
    // The other half of the same change: a workspace ingested BEFORE the move
    // has bytes only at the legacy address, and a sync that assumed one address
    // would stop mirroring for it. Both are copied, each skipped when absent.
    await writeWikiPage("epsilon", "# Epsilon");
    await getStorage().writeFile("raw/epsilon.md", "legacy bytes");

    expect(await syncSiloForPage("epsilon", "alice")).toBe(2);
    expect(await getStorage().readFile("tenants/alice/raw/epsilon.md")).toBe(
      "legacy bytes",
    );
  });

  // ── DW-435: the per-slug HASHED tree `raw/sources/<slug>/<rawId>.<ext>` ──
  // Workbench Intake writes arrivals there, and ingest callers that omit
  // `{ owner }` rely on this sync to mirror them. Before DW-435 neither
  // direction knew the address, so those arrivals were invisible in Files
  // forever (raw/ resolves silo-only, DW-40) and survived page deletion as
  // silo ghosts.

  it("mirrors hashed Intake arrivals from raw/sources/<slug>/ (DW-435)", async () => {
    const hex = "a".repeat(64);
    await writeWikiPage("zeta", "# Zeta");
    await getStorage().writeFile(`raw/sources/zeta/${hex}.md`, "hashed bytes");

    // Page md + the hashed arrival. No flat `raw/sources/zeta.md` exists.
    expect(await syncSiloForPage("zeta", "alice")).toBe(2);
    expect(
      await getStorage().readFile(`tenants/alice/raw/sources/zeta/${hex}.md`),
    ).toBe("hashed bytes");
  });

  it("mirrors hashed BINARY arrivals byte-for-byte", async () => {
    // saveRawSourceBytes publishes PDFs/DOCX/JPEGs into the same namespace as
    // the extracted .md, so the copy must go through the asset door — a UTF-8
    // round-trip would mangle these bytes.
    const hex = "b".repeat(64);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80]);
    await writeWikiPage("eta", "# Eta");
    await getStorage().writeAsset(
      `raw/sources/eta/${hex}.pdf`,
      bytes.buffer.slice(0) as ArrayBuffer,
    );

    expect(await syncSiloForPage("eta", "alice")).toBe(2);
    const mirrored = new Uint8Array(
      await getStorage().readAsset(`tenants/alice/raw/sources/eta/${hex}.pdf`),
    );
    expect(Array.from(mirrored)).toEqual(Array.from(bytes));
  });

  it("skips already-mirrored hashed entries and picks up new ones", async () => {
    // Hashed keys are IMMUTABLE (the name is the hash of the bytes), so a
    // re-sync must not re-copy them — the same subrequest bound the revision
    // and asset loops carry.
    const hex1 = "c".repeat(64);
    const hex2 = "d".repeat(64);
    await writeWikiPage("theta", "# Theta");
    await getStorage().writeFile(`raw/sources/theta/${hex1}.md`, "one");

    expect(await syncSiloForPage("theta", "alice")).toBe(2); // md + hashed
    expect(await syncSiloForPage("theta", "alice")).toBe(1); // md only

    await getStorage().writeFile(`raw/sources/theta/${hex2}.md`, "two");
    expect(await syncSiloForPage("theta", "alice")).toBe(2); // md + the new one
    expect(
      await getStorage().readFile(`tenants/alice/raw/sources/theta/${hex2}.md`),
    ).toBe("two");
  });

  it("skips subdirectories at the top of the hashed tree", async () => {
    // Folder imports write `raw/sources/<dir>/<sub>/<file>` and can nest
    // deeper; the top-level loop copies files only, exactly like raw/assets.
    const hex = "e".repeat(64);
    await writeWikiPage("iota", "# Iota");
    await getStorage().writeFile(`raw/sources/iota/${hex}.md`, "sibling");
    await getStorage().writeFile("raw/sources/iota/nested/deep.md", "nested");

    expect(await syncSiloForPage("iota", "alice")).toBe(2); // md + the sibling
    expect(
      await getStorage().readFile(`tenants/alice/raw/sources/iota/${hex}.md`),
    ).toBe("sibling");
    expect(
      await getStorage().fileExists("tenants/alice/raw/sources/iota/nested/deep.md"),
    ).toBe(false);
  });

  it("leaves a flat-only slug's count unchanged, at ONE listing", async () => {
    // The cost constraint has two halves, and the count only pins one. Spy on
    // the provider so the ORDER is pinned too: hoisting the silo-side listSafe
    // above the flat one, or dropping the `length > 0` guard, would keep the
    // count at 2 while costing every flat-only slug a second listing on every
    // write — the exact regression this constraint exists to prevent.
    await writeWikiPage("kappa", "# Kappa");
    await getStorage().writeFile("raw/sources/kappa.md", "flat bytes");

    const spy = vi.spyOn(getStorage(), "listFiles");
    try {
      expect(await syncSiloForPage("kappa", "alice")).toBe(2); // md + flat source

      const prefixes = spy.mock.calls.map((c) => c[0]);
      // Each absent flat hashed prefix is listed exactly once...
      expect(prefixes.filter((p) => p === "raw/sources/kappa")).toHaveLength(1);
      expect(prefixes.filter((p) => p === "raw/kappa")).toHaveLength(1);
      // ...and neither silo side is listed at all. Mirroring the legacy root
      // too (DW-610) must not cost a flat-only page a second pair of listings.
      expect(prefixes).not.toContain("tenants/alice/raw/sources/kappa");
      expect(prefixes).not.toContain("tenants/alice/raw/kappa");
    } finally {
      spy.mockRestore();
    }
  });

  it("mirrors BOTH layouts when a slug has flat and hashed sources", async () => {
    // The realistic shape: ingest() writes a slug both ways, so the two blocks
    // have to compose rather than one shadowing the other.
    const hex = "1".repeat(64);
    await writeWikiPage("mu", "# Mu");
    await getStorage().writeFile("raw/sources/mu.md", "flat bytes");
    await getStorage().writeFile(`raw/sources/mu/${hex}.md`, "hashed bytes");

    // md + flat source + hashed arrival.
    expect(await syncSiloForPage("mu", "alice")).toBe(3);
    expect(await getStorage().readFile("tenants/alice/raw/sources/mu.md")).toBe(
      "flat bytes",
    );
    expect(
      await getStorage().readFile(`tenants/alice/raw/sources/mu/${hex}.md`),
    ).toBe("hashed bytes");
  });

  it("does not mirror dotfiles out of the hashed tree", async () => {
    // `.DS_Store` and friends are not Sources — listRawSources and
    // listRawSourceSnapshots both skip them, and mirroring one would make it
    // Workbench-visible in Files, which no reader would ever open.
    const hex = "2".repeat(64);
    await writeWikiPage("nu", "# Nu");
    await getStorage().writeFile(`raw/sources/nu/${hex}.md`, "real source");
    await getStorage().writeFile("raw/sources/nu/.DS_Store", "junk");

    expect(await syncSiloForPage("nu", "alice")).toBe(2); // md + the real source
    expect(
      await getStorage().fileExists(`tenants/alice/raw/sources/nu/${hex}.md`),
    ).toBe(true);
    expect(
      await getStorage().fileExists("tenants/alice/raw/sources/nu/.DS_Store"),
    ).toBe(false);
  });

  it("removeSiloForPage clears the hashed silo directory (DW-435)", async () => {
    const hex = "f".repeat(64);
    await writeWikiPage("lambda", "# Lambda");
    await getStorage().writeFile(`raw/sources/lambda/${hex}.md`, "hashed bytes");
    await syncSiloForPage("lambda", "alice");
    expect(
      await getStorage().fileExists(`tenants/alice/raw/sources/lambda/${hex}.md`),
    ).toBe(true);

    await removeSiloForPage("lambda", "alice");
    expect(
      await getStorage().fileExists(`tenants/alice/raw/sources/lambda/${hex}.md`),
    ).toBe(false);
    expect(
      (await getStorage().listFiles("tenants/alice/raw/sources")).map((f) => f.name),
    ).not.toContain("lambda");
    // The FLAT tree is untouched — this is a mirror/cleanup change, not a
    // source deleter (cascade delete owns the flat hashed bytes).
    expect(await getStorage().fileExists(`raw/sources/lambda/${hex}.md`)).toBe(true);
  });

  // ── DW-610: the LEGACY hashed root `raw/<slug>/<rawId>.<ext>` ──
  // A workspace ingested before the `raw/sources/` move has arrivals only
  // there. `readRawSourceById` falls back to it and `listRawSourceSnapshots`
  // enumerates it, so it is a real source location — but nothing mirrored it,
  // and `raw/` resolves silo-only (DW-40), so those arrivals were invisible in
  // Files forever.

  it("mirrors the legacy hashed root, address-preservingly (DW-610)", async () => {
    const hex = "3".repeat(64);
    await writeWikiPage("omicron", "# Omicron");
    await getStorage().writeFile(`raw/omicron/${hex}.md`, "pre-move bytes");

    // Page md + the legacy hashed arrival.
    expect(await syncSiloForPage("omicron", "alice")).toBe(2);
    // `tenants/<t>/raw/<slug>/…`, NOT the modern `raw/sources/<slug>/…`
    // spelling — the same convention the legacy flat `raw/<slug>.md` mirror
    // follows, so the silo stays a faithful picture of the flat tree.
    expect(
      await getStorage().readFile(`tenants/alice/raw/omicron/${hex}.md`),
    ).toBe("pre-move bytes");
    expect(
      await getStorage().fileExists(`tenants/alice/raw/sources/omicron/${hex}.md`),
    ).toBe(false);
  });

  it("makes a legacy hashed arrival VISIBLE in the Files tree", async () => {
    // The harm DW-610 names is not "a storage key is missing" — it is
    // "invisible in Files". Every other assertion here is at the key layer, so
    // this one goes through the real reader: `listWorkbenchFilePaths` resolves
    // `raw/` strictly inside the owner's silo (DW-40) and walks the WHOLE silo
    // `raw/` root, which is what makes the address-preserving legacy mirror
    // show up without the modern `sources/` spelling.
    //
    // `ownerToTenant("alice") === "alice"`, so the owner the Workbench asks
    // with is the tenant the mirror wrote to.
    const hex = "b3".repeat(32);
    await writeWikiPage("upsilon", "# Upsilon");
    await getStorage().writeFile(`raw/upsilon/${hex}.md`, "pre-move bytes");

    const before = await listWorkbenchFilePaths("alice", null, {
      readableSlugs: new Set(["upsilon"]),
      hiddenSlugs: new Set<string>(),
    });
    expect(before.paths).not.toContain(`raw/upsilon/${hex}.md`);

    await syncSiloForPage("upsilon", "alice");

    const after = await listWorkbenchFilePaths("alice", null, {
      readableSlugs: new Set(["upsilon"]),
      hiddenSlugs: new Set<string>(),
    });
    expect(after.paths).toContain(`raw/upsilon/${hex}.md`);
  });

  it("mirrors a legacy hashed BINARY arrival byte-for-byte", async () => {
    const hex = "4".repeat(64);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x7f, 0x81]);
    await writeWikiPage("pi", "# Pi");
    await getStorage().writeAsset(
      `raw/pi/${hex}.pdf`,
      bytes.buffer.slice(0) as ArrayBuffer,
    );

    expect(await syncSiloForPage("pi", "alice")).toBe(2);
    const mirrored = new Uint8Array(
      await getStorage().readAsset(`tenants/alice/raw/pi/${hex}.pdf`),
    );
    expect(Array.from(mirrored)).toEqual(Array.from(bytes));
  });

  it("skips the legacy root for a slug naming a structural root", async () => {
    // `raw/sources/` is not one page's directory — it holds every page's
    // Sources. A page really slugged `sources` must not read the root as its
    // own legacy tree, and the path alone cannot tell the two apart, so the
    // mirror fails CLOSED exactly as `rawPathSlug` does for `parsed`.
    const hex = "5".repeat(64);
    await writeWikiPage("sources", "# Sources");
    await getStorage().writeFile("raw/sources/otherpage.md", "someone else's");
    await getStorage().writeFile(`raw/sources/otherpage/${hex}.md`, "theirs");
    // The page's OWN modern tree is still mirrored.
    await getStorage().writeFile(`raw/sources/sources/${hex}.md`, "mine");

    const spy = vi.spyOn(getStorage(), "listFiles");
    let n: number;
    try {
      n = await syncSiloForPage("sources", "alice");
      expect(spy.mock.calls.map((c) => c[0])).not.toContain("raw/sources");
    } finally {
      spy.mockRestore();
    }

    expect(n).toBe(2); // md + the page's own modern hashed arrival
    expect(
      await getStorage().readFile(`tenants/alice/raw/sources/sources/${hex}.md`),
    ).toBe("mine");
    expect(
      await getStorage().fileExists("tenants/alice/raw/otherpage.md"),
    ).toBe(false);

    // …and the delete side skips it too: nothing of the shared root is removed.
    await getStorage().writeFile("tenants/alice/raw/sources/otherpage.md", "x");
    // The entry that actually OBSERVES the skip. `otherpage.md` and the
    // `sources/` directory both land in `removeHashedTree`'s foreign branch, so
    // they survive whether or not the structural-root guard is there. This one
    // is snapshot-NAMED and sits directly under the shared root — it is the
    // flat Source mirror of a page whose slug happens to be all hex — so
    // dropping the guard points `removeHashedTree` at `tenants/alice/raw/
    // sources` and deletes it along with the page called `sources`.
    await getStorage().writeFile("tenants/alice/raw/sources/beef.md", "hex-slug page");

    await removeSiloForPage("sources", "alice");
    expect(
      await getStorage().fileExists(`tenants/alice/raw/sources/sources/${hex}.md`),
    ).toBe(false);
    expect(
      await getStorage().fileExists("tenants/alice/raw/sources/otherpage.md"),
    ).toBe(true);
    expect(await getStorage().readFile("tenants/alice/raw/sources/beef.md")).toBe(
      "hex-slug page",
    );
  });

  it("a page slugged `assets` deletes nothing out of the asset root", async () => {
    // `assets` is the name the mirror's own comment singles out, because
    // `raw/assets/<hex>.<ext>` is genuinely ambiguous: it could be the legacy
    // hashed Source of a page really slugged `assets`, or residue of something
    // else entirely, and the path cannot say which. Withholding costs that page
    // its legacy snapshots; deleting would take content the mirror never put
    // there. The silo mirror never wrote this file, so the silo delete does not
    // get to remove it.
    const hex = "a1b2".repeat(16);
    const storage = getStorage();
    await storage.writeFile(`tenants/alice/raw/assets/${hex}.md`, "ambiguous");
    await storage.writeFile(`tenants/alice/raw/sources/assets/${hex}.md`, "page-owned");

    await removeSiloForPage("assets", "alice");

    // The page's own modern tree goes…
    expect(
      await storage.fileExists(`tenants/alice/raw/sources/assets/${hex}.md`),
    ).toBe(false);
    // …the structural root is not touched.
    expect(await storage.readFile(`tenants/alice/raw/assets/${hex}.md`)).toBe(
      "ambiguous",
    );
  });

  // ── DW-611: `raw/sources/<name>/` is SHARED with folder imports ──
  // `saveRawSourceTree` addresses that directory by import root while
  // `saveRawSourceFor`/`saveRawSourceBytes` address it by page slug, so a page
  // slugged like an import root shares it. Only the content-addressed
  // `<hex>.<ext>` names are page-owned.

  it("does not mirror a folder-import file sharing the hashed directory", async () => {
    const hex = "6".repeat(64);
    await writeWikiPage("papers", "# Papers");
    await getStorage().writeFile(`raw/sources/papers/${hex}.md`, "snapshot");
    await getStorage().writeFile("raw/sources/papers/note.md", "import file");

    expect(await syncSiloForPage("papers", "alice")).toBe(2); // md + snapshot
    expect(
      await getStorage().readFile(`tenants/alice/raw/sources/papers/${hex}.md`),
    ).toBe("snapshot");
    expect(
      await getStorage().fileExists("tenants/alice/raw/sources/papers/note.md"),
    ).toBe(false);
  });

  it("does not mirror a short-hex import file, and spares it on delete (DW-744)", async () => {
    // `2024.pdf` is the DW-744 shape: a folder-import file at the TOP of its
    // root whose stem is all hex. While any hex stem was an id it was
    // page-owned by name, so this mirror carried somebody else's import file
    // into the colliding page's silo and `removeSiloForPage` deleted it with
    // the page. 4 is not a length any writer mints, so it is an import file.
    const hex = "8".repeat(64);
    const storage = getStorage();
    await writeWikiPage("papers", "# Papers");
    await storage.writeFile(`raw/sources/papers/${hex}.pdf`, "snapshot");
    await storage.writeFile("raw/sources/papers/2024.pdf", "import file");

    expect(await syncSiloForPage("papers", "alice")).toBe(2); // md + snapshot
    expect(
      await storage.fileExists("tenants/alice/raw/sources/papers/2024.pdf"),
    ).toBe(false);

    // And the copy an OLDER mirror already left behind survives the delete
    // rather than going with the page.
    await storage.writeFile("tenants/alice/raw/sources/papers/2024.pdf", "theirs");
    await removeSiloForPage("papers", "alice");
    expect(
      await storage.readFile("tenants/alice/raw/sources/papers/2024.pdf"),
    ).toBe("theirs");
  });

  it("removeSiloForPage spares foreign entries in a shared directory", async () => {
    // The recursive directory delete this replaces took the whole import tree
    // — possibly another owner's — with the colliding page.
    const hex = "7".repeat(64);
    const storage = getStorage();
    await storage.writeFile(`tenants/alice/raw/sources/papers/${hex}.md`, "mine");
    await storage.writeFile("tenants/alice/raw/sources/papers/note.md", "theirs");
    await storage.writeFile("tenants/alice/raw/sources/papers/sub/deep.md", "deep");

    await removeSiloForPage("papers", "alice");

    expect(
      await storage.fileExists(`tenants/alice/raw/sources/papers/${hex}.md`),
    ).toBe(false);
    expect(
      await storage.readFile("tenants/alice/raw/sources/papers/note.md"),
    ).toBe("theirs");
    expect(
      await storage.readFile("tenants/alice/raw/sources/papers/sub/deep.md"),
    ).toBe("deep");
  });

  it("removeSiloForPage removes a page-only directory outright, at both roots", async () => {
    const hex = "8".repeat(64);
    const storage = getStorage();
    await storage.writeFile(`tenants/alice/raw/sources/rho/${hex}.md`, "modern");
    await storage.writeFile(`tenants/alice/raw/rho/${hex}.md`, "legacy");

    await removeSiloForPage("rho", "alice");

    expect(
      (await storage.listFiles("tenants/alice/raw/sources")).map((f) => f.name),
    ).not.toContain("rho");
    expect(
      (await storage.listFiles("tenants/alice/raw")).map((f) => f.name),
    ).not.toContain("rho");
  });

  it("removeSiloForPage clears the page from its silo", async () => {
    await writeWikiPage("gamma", "# Gamma");
    await syncSiloForPage("gamma", "alice");
    expect(await getStorage().fileExists("tenants/alice/wiki/gamma.md")).toBe(
      true,
    );
    await removeSiloForPage("gamma", "alice");
    expect(await getStorage().fileExists("tenants/alice/wiki/gamma.md")).toBe(
      false,
    );
  });
});

describe("removeSiloForPage on page delete", () => {
  // ── DW-609 routes the real page delete through here ──
  // The narrowness DW-611 bought is only worth anything if it survives the
  // caller that now runs on EVERY hard delete, so assert it through
  // `deleteWikiPage` and not just a direct `removeSiloForPage` call.

  it("a page delete spares a foreign file and its shared hashed directory", async () => {
    const hex = "9".repeat(64);
    const storage = getStorage();
    const tenant = "yopedia"; // ownerless page → default tenant
    await writeWikiPage("papers", "# Papers\n\nBody.");
    await updateIndex([
      { title: "Papers", slug: "papers", summary: "shares a hashed dir" },
    ]);
    await storage.writeFile(`tenants/${tenant}/raw/sources/papers/${hex}.md`, "mine");
    await storage.writeFile(
      `tenants/${tenant}/raw/sources/papers/note.md`,
      "import file",
    );

    await deleteWikiPage("papers");

    // The page-owned content-addressed snapshot goes…
    expect(
      await storage.fileExists(`tenants/${tenant}/raw/sources/papers/${hex}.md`),
    ).toBe(false);
    // …the folder-import file and the directory holding it survive.
    expect(
      await storage.readFile(`tenants/${tenant}/raw/sources/papers/note.md`),
    ).toBe("import file");
  });

  it("preserveRawSources keeps the raw Sources while clearing the rest", async () => {
    // The merge-absorb delete: `mergePages` unions the absorbed page's sources
    // into the SURVIVOR's frontmatter before deleting it through the same
    // branch, so these bytes are provenance the survivor now claims.
    const hex = "c".repeat(64);
    const storage = getStorage();
    const kept = [
      "tenants/alice/raw/sources/sigma.md",
      "tenants/alice/raw/sigma.md",
      `tenants/alice/raw/sources/sigma/${hex}.md`,
      `tenants/alice/raw/sigma/${hex}.md`,
    ];
    const cleared = [
      "tenants/alice/wiki/sigma.md",
      "tenants/alice/discuss/sigma.json",
      // The revisions arm must keep running under `preserveRawSources` — only
      // the RAW-SOURCE arms are skipped. Without this a regression that
      // bundled `.revisions` in with the skipped arms would go unnoticed.
      "tenants/alice/wiki/.revisions/sigma/2026-01-01T00-00-00.md",
      "tenants/alice/raw/assets/sigma/pic.png",
    ];
    for (const rel of [...kept, ...cleared]) {
      await storage.writeFile(rel, "mirrored bytes");
    }

    await removeSiloForPage("sigma", "alice", { preserveRawSources: true });

    for (const rel of kept) {
      expect(await storage.fileExists(rel), rel).toBe(true);
    }
    for (const rel of cleared) {
      expect(await storage.fileExists(rel), rel).toBe(false);
    }

    // Default (discard) behaviour is unchanged — the same silo clears fully.
    await removeSiloForPage("sigma", "alice");
    for (const rel of kept) {
      expect(await storage.fileExists(rel), rel).toBe(false);
    }
  });
});

describe("reconcileSilos", () => {
  it("syncs pages that are missing from their tenant silo", async () => {
    // Write two pages with owner frontmatter.
    await writeWikiPage(
      "page-a",
      "---\nowner: alice\n---\n# Page A\n\nContent A.",
    );
    await writeWikiPage(
      "page-b",
      "---\nowner: bob\n---\n# Page B\n\nContent B.",
    );
    // Populate the index so listWikiPages finds them.
    await updateIndex([
      { slug: "page-a", title: "Page A", summary: "A" },
      { slug: "page-b", title: "Page B", summary: "B" },
    ]);

    // Neither silo exists yet — reconcile should sync both.
    const result = await reconcileSilos();
    expect(result.total).toBe(2);
    expect(result.synced).toBe(2);
    expect(result.alreadyCurrent).toBe(0);
    expect(result.errors).toEqual([]);

    // Verify the silo files were actually created.
    expect(await getStorage().fileExists("tenants/alice/wiki/page-a.md")).toBe(
      true,
    );
    expect(await getStorage().fileExists("tenants/bob/wiki/page-b.md")).toBe(
      true,
    );
  });

  it("skips pages that already have a silo copy", async () => {
    await writeWikiPage(
      "page-c",
      "---\nowner: carol\n---\n# Page C\n\nContent C.",
    );
    await updateIndex([
      { slug: "page-c", title: "Page C", summary: "C" },
    ]);
    // Pre-sync so the silo already exists.
    await syncSiloForPage("page-c", "carol");

    const result = await reconcileSilos();
    expect(result.total).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.alreadyCurrent).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("repairs a hashed Source under an already-current page (DW-608)", async () => {
    // The gate this replaces only ran the sync when the silo md was missing or
    // differed from flat — and `lifecycle.ts` writes both from the identical
    // content, so a live page always landed on `alreadyCurrent` and NOTHING
    // was ever repaired for it. A Source that arrives after the md was
    // mirrored is exactly that case.
    const hex = "9".repeat(64);
    const storage = getStorage();
    await writeWikiPage(
      "page-d",
      "---\nowner: alice\n---\n# Page D\n\nContent D.",
    );
    await updateIndex([{ slug: "page-d", title: "Page D", summary: "D" }]);
    await syncSiloForPage("page-d", "alice");

    // Arrives afterwards; the md stays byte-identical to flat.
    await storage.writeFile(`raw/sources/page-d/${hex}.md`, "late arrival");
    await storage.writeFile(`raw/page-d/${hex}.md`, "late legacy arrival");

    const result = await reconcileSilos();
    // Still counted exactly once, and still as already-current: the md really
    // did match. The counter classifies the md, it does not report idleness.
    expect(result.total).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.stale).toBe(0);
    expect(result.alreadyCurrent).toBe(1);
    expect(result.errors).toEqual([]);

    expect(
      await storage.readFile(`tenants/alice/raw/sources/page-d/${hex}.md`),
    ).toBe("late arrival");
    expect(await storage.readFile(`tenants/alice/raw/page-d/${hex}.md`)).toBe(
      "late legacy arrival",
    );
  });

  it("skips infrastructure slugs (index, log)", async () => {
    await writeWikiPage("real-page", "---\nowner: dan\n---\n# Real\n\nContent.");
    // index and log are infra — they should be skipped.
    await updateIndex([
      { slug: "index", title: "Index", summary: "Index" },
      { slug: "log", title: "Log", summary: "Log" },
      { slug: "real-page", title: "Real", summary: "Content" },
    ]);

    const result = await reconcileSilos();
    expect(result.total).toBe(1); // only real-page counted
    expect(result.synced).toBe(1);
  });

  it("returns a mix of synced and already-current pages", async () => {
    await writeWikiPage(
      "existing",
      "---\nowner: eve\n---\n# Existing\n\nExists.",
    );
    await writeWikiPage(
      "missing",
      "---\nowner: eve\n---\n# Missing\n\nNot synced.",
    );
    await updateIndex([
      { slug: "existing", title: "Existing", summary: "Exists" },
      { slug: "missing", title: "Missing", summary: "Not synced" },
    ]);
    // Only sync 'existing' — leave 'missing' without a silo copy.
    await syncSiloForPage("existing", "eve");

    const result = await reconcileSilos();
    expect(result.total).toBe(2);
    expect(result.synced).toBe(1);
    expect(result.alreadyCurrent).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("uses DEFAULT_TENANT for pages without an owner", async () => {
    await writeWikiPage("orphan", "# Orphan\n\nNo owner frontmatter.");
    await updateIndex([
      { slug: "orphan", title: "Orphan", summary: "No owner" },
    ]);

    const result = await reconcileSilos();
    expect(result.total).toBe(1);
    expect(result.synced).toBe(1);

    // DEFAULT_TENANT is "work-wiki" — the fallback for ownerless pages.
    expect(await getStorage().fileExists("tenants/yopedia/wiki/orphan.md")).toBe(
      true,
    );
  });

  it("detects and re-syncs stale silo content", async () => {
    const storage = getStorage();

    // Write a page and sync it to the silo.
    await writeWikiPage(
      "stale-page",
      "---\nowner: frank\n---\n# Stale\n\nOriginal content.",
    );
    await updateIndex([
      { slug: "stale-page", title: "Stale", summary: "Original" },
    ]);
    await syncSiloForPage("stale-page", "frank");

    // Verify silo matches flat.
    expect(await storage.readFile("tenants/frank/wiki/stale-page.md")).toContain(
      "Original content.",
    );

    // Simulate stale silo: update flat WITHOUT re-syncing to silo.
    await writeWikiPage(
      "stale-page",
      "---\nowner: frank\n---\n# Stale\n\nUpdated content.",
    );

    // Silo still has old content.
    expect(await storage.readFile("tenants/frank/wiki/stale-page.md")).toContain(
      "Original content.",
    );

    // reconcileSilos should detect the divergence and repair it.
    const result = await reconcileSilos();
    expect(result.total).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.stale).toBe(1);
    expect(result.alreadyCurrent).toBe(0);
    expect(result.errors).toEqual([]);

    // Silo should now have the updated content.
    expect(await storage.readFile("tenants/frank/wiki/stale-page.md")).toContain(
      "Updated content.",
    );
  });

  it("removes ghost silo files that have no index entry", async () => {
    const storage = getStorage();

    // A real page: in the index and synced to silo.
    await writeWikiPage("real", "---\nowner: alice\n---\n# Real\n\nContent.");
    await updateIndex([{ slug: "real", title: "Real", summary: "Content" }]);
    await syncSiloForPage("real", "alice");

    // A ghost: silo file exists but NO index entry.
    await storage.writeFile("tenants/alice/wiki/ghost.md", "# Ghost");

    const result = await reconcileSilos();
    expect(result.removed).toBe(1);
    expect(await storage.fileExists("tenants/alice/wiki/ghost.md")).toBe(false);
    // Real page's silo is untouched.
    expect(await storage.fileExists("tenants/alice/wiki/real.md")).toBe(true);
  });
});
