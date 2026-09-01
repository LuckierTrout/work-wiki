/**
 * DW-40, the branch no fixture can reach without a mock: what the two display
 * roots resolve to when the owner has NO resolvable tenant.
 *
 * `ownerToTenant` sanitizes every input and falls back to `DEFAULT_TENANT`, so
 * today nothing makes `tenantForOwner` throw. The `!siloPrefix` branch of
 * `resolveRoot` is therefore defense-in-depth — and defense-in-depth that
 * nothing pins is one refactor of the owner→tenant mapping away from silently
 * becoming a fallback to the SHARED flat `raw/` tree, which is the exact leak
 * DW-40 closed. So the throw is injected here.
 *
 * BOTH arms are asserted, because DW-40's whole content is that they now
 * differ. Pinning only `raw/` leaves the asymmetry half-covered: the `raw/`
 * side cannot silently become a leak, but the `wiki/` side can silently become
 * a BLACKOUT — a "make the arms symmetric" edit that gave `wiki/` the same
 * no-tenant sentinel would empty the Files tab for every pre-migration
 * workspace, and the rest of the suite would stay green.
 *
 * Its own file, not a case inside `workbench-tree.test.ts`: `vi.mock` applies
 * to this file's whole module registry, so `tenantForOwner` throws for every
 * importer it reaches — no case here can ever have a working tenant.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { logger } from "../logger";

vi.mock("../wiki", async () => {
  const actual = await vi.importActual<typeof import("../wiki")>("../wiki");
  return {
    ...actual,
    tenantForOwner: () => {
      throw new Error("no tenant for this owner");
    },
  };
});

const { rawRelPath, wikiRelPath } = await import("../wiki");
const { getStorage } = await import("../storage");
const {
  listRawSourceFilePaths,
  listWorkbenchFilePaths,
  readWorkbenchFile,
  readWorkbenchFileBytes,
  workbenchFileExists,
} = await import("../workbench-files");

describe("both roots with an unresolvable tenant (DW-40)", () => {
  // The premise is that no tenant resolves for this handle, so the name says
  // so rather than borrowing a real one from the sibling suite.
  const OWNER = "owner-with-no-tenant";
  let root: string;
  let tmpDir: string;
  let caseIndex = 0;
  let originalDataDir: string | undefined;
  let originalWikiDir: string | undefined;
  let originalRawDir: string | undefined;
  /** Every storage prefix any listing in the case asked for. */
  let listed: string[];

  const gate = (...slugs: string[]) => ({
    readableSlugs: new Set(slugs),
    hiddenSlugs: new Set<string>(),
  });

  /**
   * The assertion that actually pins "never falls back": no listing under the
   * case reached the SHARED flat `raw/` prefix. Membership tests over the
   * returned paths cannot distinguish "the flat tree was read and had nothing
   * to show" from "the flat tree was never consulted"; this can.
   */
  function expectFlatRawNeverListed() {
    const flatRaw = rawRelPath("");
    expect(
      listed.filter((p) => p === flatRaw || p.startsWith(`${flatRaw}/`)),
    ).toEqual([]);
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-unresolved-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = root;
  });

  afterAll(async () => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    caseIndex += 1;
    tmpDir = path.join(root, `case-${caseIndex}`);
    originalWikiDir = process.env.WIKI_DIR;
    originalRawDir = process.env.RAW_DIR;
    process.env.WIKI_DIR = path.join(tmpDir, "wiki");
    process.env.RAW_DIR = path.join(tmpDir, "raw");
    await fs.mkdir(process.env.WIKI_DIR, { recursive: true });
    await fs.mkdir(path.join(process.env.RAW_DIR, "sources"), { recursive: true });

    listed = [];
    const storage = getStorage();
    const realList = storage.listFiles.bind(storage);
    vi.spyOn(storage, "listFiles").mockImplementation(async (prefix: string) => {
      listed.push(prefix);
      return realList(prefix);
    });
  });

  afterEach(async () => {
    // `finally`, because the storage provider is a MODULE-LEVEL SINGLETON: a
    // rejecting `fs.rm` would otherwise leak this case's `listFiles` spy into
    // every later case in this file.
    try {
      if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
      else process.env.WIKI_DIR = originalWikiDir;
      if (originalRawDir === undefined) delete process.env.RAW_DIR;
      else process.env.RAW_DIR = originalRawDir;
      // Only inside the fixture. `tenants/` is swept too: nothing here writes a
      // silo today (the mock refuses to name one), but a case that did would
      // otherwise leak into the next through the shared `root`.
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(path.join(root, "tenants"), { recursive: true, force: true });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("lists nothing under raw/ and refuses its reads, rather than serving the shared flat tree", async () => {
    // Bytes in the SHARED flat tree at all three real `raw/` addresses — the
    // pre-`sources` residue, the flat source, and a hashed snapshot — plus the
    // silo-mirrored binary tree the media door serves. An owner with no tenant
    // must see none of them.
    await fs.mkdir(path.join(tmpDir, "raw", "sources", "theirs"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "raw", "assets", "theirs"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "raw", "theirs.md"), "not yours", "utf-8");
    await fs.writeFile(path.join(tmpDir, "raw", "sources", "theirs.md"), "nor this", "utf-8");
    await fs.writeFile(
      path.join(tmpDir, "raw", "sources", "theirs", "abc123.md"),
      "nor this either",
      "utf-8",
    );
    await fs.writeFile(path.join(tmpDir, "raw", "assets", "theirs", "img.png"), "PNG", "utf-8");

    const errors = vi.spyOn(logger, "error").mockImplementation(() => {});

    const { paths } = await listWorkbenchFilePaths(OWNER, null, gate());
    // The EXACT shape, not a filtered subset: a regression that dropped the
    // `raw/` root entirely would satisfy "no `raw/` leaf leaked" too, and the
    // tab has to keep telling "no sources yet" apart from "no root".
    expect(paths).toEqual(["raw/", "wiki/"]);

    for (const display of [
      "raw/theirs.md",
      "raw/sources/theirs.md",
      "raw/sources/theirs/abc123.md",
    ]) {
      expect(await readWorkbenchFile(OWNER, null, display, gate())).toBeNull();
      expect(await workbenchFileExists(OWNER, null, display, gate())).toBe(false);
    }
    // The MEDIA door (Story 7.7) shares `resolveWorkbenchFile` with the text
    // one, so it is the second consumer of this gate — and the only one that
    // serves `raw/assets/<slug>/…` (DW-491).
    expect(
      await readWorkbenchFileBytes(OWNER, null, "raw/assets/theirs/img.png", gate()),
    ).toBeNull();

    expectFlatRawNeverListed();
    // "Logged, refused" is the matrix's error handling for this row: a branch
    // that refused SILENTLY would leave an operator with an empty tab and no
    // trace of why.
    expect(errors).toHaveBeenCalled();
    expect(errors.mock.calls.some(([scope]) => scope === "workbench-files")).toBe(true);
  });

  it("keeps the wiki/ flat fallback, which raw/ does not have", async () => {
    // The other arm of the same split, in the only fixture that can reach it.
    // `wiki/` is silo-first-then-FLAT precisely so a pre-migration workspace
    // still lists its pages, and a null silo is the strongest form of "no
    // silo yet".
    await fs.writeFile(path.join(tmpDir, "wiki", "flat-page.md"), "page bytes", "utf-8");

    const { paths } = await listWorkbenchFilePaths(OWNER, null, gate("flat-page"));
    expect(paths).toEqual(["raw/", "wiki/", "wiki/flat-page.md"]);
    await expect(
      readWorkbenchFile(OWNER, null, "wiki/flat-page.md", gate("flat-page")),
    ).resolves.toEqual({ content: "page bytes" });
    // The flat WIKI root was consulted; the flat RAW root still was not.
    expect(listed).toContain(wikiRelPath(""));
    expectFlatRawNeverListed();
  });

  it("reports the Sources pager as FAILED and never reads the flat root", async () => {
    await fs.writeFile(
      path.join(tmpDir, "raw", "sources", "theirs.md"),
      "not yours",
      "utf-8",
    );

    const page = await listRawSourceFilePaths(OWNER, { limit: 10, hiddenSlugs: new Set<string>() });
    // An unresolvable tenant is unreadable, not empty: a `failed: false` empty
    // page would tell the caller it had observed a complete ordering.
    expect(page).toEqual({ paths: [], more: false, remaining: 0, failed: true });
    // `failed` alone is set by the pager's OWN catch, before `resolveRoot` is
    // consulted, so the shape above would hold even if the raw arm fell back.
    // This is the half that pins the fallback's absence.
    expectFlatRawNeverListed();
  });
});
