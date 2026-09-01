import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";

import { serializeFrontmatter } from "../frontmatter";
import { writeWikiPageWithSideEffects } from "../lifecycle";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";
import { readWikiPageWithFrontmatter } from "../wiki";

describe("CLI writes through the real lifecycle", () => {
  let tmpDir: string;
  let originalWikiDir: string | undefined;
  let originalRawDir: string | undefined;
  let originalDataDir: string | undefined;
  let originalStdin: NodeJS.ReadStream;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-lifecycle-"));
    originalWikiDir = process.env.WIKI_DIR;
    originalRawDir = process.env.RAW_DIR;
    originalDataDir = process.env.DATA_DIR;
    originalStdin = process.stdin;
    process.env.WIKI_DIR = path.join(tmpDir, "wiki");
    process.env.RAW_DIR = path.join(tmpDir, "raw");
    process.env.DATA_DIR = tmpDir;
    await fs.mkdir(path.join(tmpDir, "wiki"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "raw"), { recursive: true });
    _resetLocks();
    _resetStorage();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
    if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = originalWikiDir;
    if (originalRawDir === undefined) delete process.env.RAW_DIR;
    else process.env.RAW_DIR = originalRawDir;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    vi.restoreAllMocks();
    _resetStorage();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Feed `body` on stdin, then run the CLI create door. */
  async function runCreateWithStdin(slug: string, title: string, body: string): Promise<void> {
    const stdin = new Readable();
    stdin.push(body);
    stdin.push(null);
    Object.defineProperty(process, "stdin", { value: stdin, writable: true });
    const { runCreate } = await import("../../cli");
    await runCreate(slug, title);
  }

  /** Feed `body` on stdin, then run the CLI update door. */
  async function runUpdateWithStdin(slug: string, body: string): Promise<void> {
    const stdin = new Readable();
    stdin.push(body);
    stdin.push(null);
    Object.defineProperty(process, "stdin", { value: stdin, writable: true });
    const { runUpdate } = await import("../../cli");
    await runUpdate(slug);
  }

  it("rejects an update linking to a same-owner recreated merged slug and preserves the Page", async () => {
    const common = {
      owner: "alice",
      visibility: "private",
      authors: ["alice"],
      contributors: ["alice"],
    };
    await writeWikiPageWithSideEffects({
      slug: "cli-survivor",
      title: "Survivor",
      content: serializeFrontmatter(
        { ...common, title: "Survivor", aliases: ["cli-retired"] },
        "# Survivor\n\nCanonical Page.",
      ),
      summary: "canonical",
      logOp: "ingest",
      crossRefSource: null,
    });
    await writeWikiPageWithSideEffects({
      slug: "cli-retired",
      title: "Replacement",
      content: serializeFrontmatter(
        { ...common, title: "Replacement" },
        "# Replacement\n\nUnrelated replacement.",
      ),
      summary: "replacement",
      logOp: "ingest",
      crossRefSource: null,
    });
    await writeWikiPageWithSideEffects({
      slug: "cli-linker",
      title: "CLI linker",
      content: serializeFrontmatter(
        { ...common, title: "CLI linker" },
        "# CLI linker\n\nOriginal body.",
      ),
      summary: "original",
      logOp: "ingest",
      crossRefSource: null,
    });
    const before = (await readWikiPageWithFrontmatter("cli-linker"))!.content;
    const stdin = new Readable();
    stdin.push("# CLI linker\n\nSee [the old Page](cli-retired.md).");
    stdin.push(null);
    Object.defineProperty(process, "stdin", { value: stdin, writable: true });

    const { runUpdate } = await import("../../cli");
    await expect(runUpdate("cli-linker")).rejects.toThrow(/missing|replaced/i);

    expect((await readWikiPageWithFrontmatter("cli-linker"))!.content).toBe(before);
  });

  it("rejects a create linking to a recreated merged slug and stores no Page", async () => {
    const common = {
      visibility: "private",
      authors: ["cli"],
      contributors: ["cli"],
    };
    await writeWikiPageWithSideEffects({
      slug: "cli-create-survivor",
      title: "Survivor",
      content: serializeFrontmatter(
        { ...common, title: "Survivor", aliases: ["cli-create-retired"] },
        "# Survivor\n\nCanonical Page.",
      ),
      summary: "canonical",
      logOp: "ingest",
      crossRefSource: null,
    });
    await writeWikiPageWithSideEffects({
      slug: "cli-create-retired",
      title: "Replacement",
      content: serializeFrontmatter(
        { ...common, title: "Replacement" },
        "# Replacement\n\nUnrelated replacement.",
      ),
      summary: "replacement",
      logOp: "ingest",
      crossRefSource: null,
    });
    const stdin = new Readable();
    stdin.push("# CLI create linker\n\nSee [the old Page](cli-create-retired.md).");
    stdin.push(null);
    Object.defineProperty(process, "stdin", { value: stdin, writable: true });

    const { runCreate } = await import("../../cli");
    await expect(runCreate("cli-create-linker", "CLI create linker"))
      .rejects.toThrow(/missing|replaced/i);

    expect(await readWikiPageWithFrontmatter("cli-create-linker")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Fresh + strict reads on the CLI write doors (DW-195 / DW-378).
  //
  // `runCreate`'s conflict guard and `runUpdate`'s merge base both decide a
  // mutation. Real-fs rows because the two failure modes are storage-level:
  // a ref-counted global `pageCache` holding a superseded entry (`fresh`), and
  // a non-ENOENT provider failure flattened into `null` (`strict`).
  // -------------------------------------------------------------------------

  it("runCreate() refuses with a read error — not `already exists` — when the guard read blips", async () => {
    const { getStorage } = await import("../storage");

    await writeWikiPageWithSideEffects({
      slug: "cli-create-blip",
      title: "Blip",
      content: serializeFrontmatter(
        {
          title: "Blip",
          owner: "alice",
          visibility: "private",
          authors: ["alice"],
          contributors: ["alice"],
        },
        "# Blip\n\nThe stored bytes.",
      ),
      summary: "stored",
      logOp: "ingest",
      crossRefSource: null,
    });
    // The path the read actually takes — silo-primary for an indexed Page.
    const storedPath = (await readWikiPageWithFrontmatter("cli-create-blip"))!.path;
    const before = await fs.readFile(storedPath, "utf-8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => { throw new Error("process.exit"); }) as unknown as () => never);

    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    // ONE-SHOT: a spy that failed EVERY read of the file would also break the
    // write's own `createOnly` re-check, so the command would refuse whether or
    // not the guard rethrows — a green row that pins nothing.
    let blipped = false;
    const readSpy = vi.spyOn(storage, "readFile").mockImplementation(async (filePath: string) => {
      if (!blipped && filePath.endsWith("cli-create-blip.md")) {
        blipped = true;
        // A non-ENOENT failure: the file is there, the provider is not.
        throw new Error("storage unavailable");
      }
      return originalRead(filePath);
    });

    try {
      await expect(runCreateWithStdin("cli-create-blip", "Blip", "# Blip\n\nShould never land."))
        .rejects.toThrow("process.exit");
    } finally {
      readSpy.mockRestore();
    }

    expect(blipped).toBe(true);
    // THE WHOLE LINE, not a substring of it. The trailing clause is half of
    // what this change adds, and it is door-specific — a create door printing
    // the update door's `Nothing was written.` passes every `toContain` above.
    expect(errorSpy).toHaveBeenCalledWith(
      'Error: could not read page "cli-create-blip": storage unavailable\nNothing was created.',
    );
    const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // The half that was decorative before: a blip is not a slug conflict.
    expect(stderr).not.toContain("already exists");
    expect(exitSpy).toHaveBeenCalledWith(1);

    // And the stored Page is untouched, byte for byte.
    expect(await fs.readFile(storedPath, "utf-8")).toBe(before);
  });

  /**
   * The FRESH half, which `strict` cannot pin: drop `fresh: true` and the blip
   * row above still passes. Off a stale NEGATIVE cache entry the guard rules
   * the slug free, and the write's own `createOnly` re-check refuses instead —
   * with ITS sentence, not the CLI's. The exact CLI sentence is the assertion.
   */
  it("runCreate() checks the conflict guard against storage while a stale page cache is open", async () => {
    const { beginPageCache, readWikiPage } = await import("../wiki");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => { throw new Error("process.exit"); }) as unknown as () => never);

    const cleanup = beginPageCache();
    try {
      // A concurrent scan looks the slug up before it exists and caches the
      // miss — `readWikiPage` seeds a negative entry on a true global miss.
      expect(await readWikiPage("cli-cached-create")).toBeNull();

      // The page appears underneath it. Written DIRECTLY to the flat path,
      // bypassing the lifecycle — which invalidates — because a stale entry is
      // exactly what this row is about. This slug was never written through the
      // lifecycle, so it has no page-index entry and the read takes the flat
      // fallback.
      const storedBytes = serializeFrontmatter(
        {
          title: "Theirs",
          owner: "someone-else",
          visibility: "private",
          authors: ["someone-else"],
          contributors: ["someone-else"],
        },
        "# Theirs\n\nAlready stored by someone else.",
      );
      const flatPath = path.join(process.env.WIKI_DIR!, "cli-cached-create.md");
      await fs.writeFile(flatPath, storedBytes, "utf-8");
      // The cache is genuinely stale: a cached read still answers "no page".
      expect(await readWikiPage("cli-cached-create")).toBeNull();

      await expect(runCreateWithStdin("cli-cached-create", "Mine", "# Mine\n\nShould never land."))
        .rejects.toThrow("process.exit");

      // THE ASSERTION THAT FAILS WITHOUT THE FRESH READ. This exact sentence is
      // the CLI GUARD's; off the cached entry the write's re-check answers with
      // its own instead.
      expect(errorSpy).toHaveBeenCalledWith('Error: page "cli-cached-create" already exists.');
      expect(exitSpy).toHaveBeenCalledWith(1);

      // And the other principal's bytes are intact, byte for byte.
      expect(await fs.readFile(flatPath, "utf-8")).toBe(storedBytes);
    } finally {
      cleanup();
    }
  });

  it("runUpdate() refuses with a read error — not `not found` — when the merge-base read blips", async () => {
    const { getStorage } = await import("../storage");

    await writeWikiPageWithSideEffects({
      slug: "cli-update-blip",
      title: "Blip",
      content: serializeFrontmatter(
        {
          title: "Blip",
          owner: "alice",
          visibility: "private",
          authors: ["alice"],
          contributors: ["alice"],
        },
        "# Blip\n\nThe stored bytes.",
      ),
      summary: "stored",
      logOp: "ingest",
      crossRefSource: null,
    });
    const storedPath = (await readWikiPageWithFrontmatter("cli-update-blip"))!.path;
    const before = await fs.readFile(storedPath, "utf-8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => { throw new Error("process.exit"); }) as unknown as () => never);

    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    let blipped = false;
    const readSpy = vi.spyOn(storage, "readFile").mockImplementation(async (filePath: string) => {
      if (!blipped && filePath.endsWith("cli-update-blip.md")) {
        blipped = true;
        throw new Error("storage unavailable");
      }
      return originalRead(filePath);
    });

    try {
      await expect(runUpdateWithStdin("cli-update-blip", "# Blip\n\nShould never land."))
        .rejects.toThrow("process.exit");
    } finally {
      readSpy.mockRestore();
    }

    expect(blipped).toBe(true);
    // THE WHOLE LINE — see the create twin. `Nothing was written.` is this
    // door's clause and nothing else pins which door printed it.
    expect(errorSpy).toHaveBeenCalledWith(
      'Error: could not read page "cli-update-blip": storage unavailable\nNothing was written.',
    );
    const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // An unreadable Page is not a missing one.
    expect(stderr).not.toContain("not found");
    expect(exitSpy).toHaveBeenCalledWith(1);

    expect(await fs.readFile(storedPath, "utf-8")).toBe(before);
  });

  /**
   * The FRESH half for the merge base. These bytes become `expectedContent` on
   * the write AND the frontmatter the update merges over, so a superseded
   * cached entry merges over bytes that are no longer stored. This Page IS
   * indexed, so the read is silo-primary — supersede the AUTHORITATIVE copy the
   * read actually resolves, or the cached-vs-stored distinction never
   * materialises.
   */
  it("runUpdate() merges over the STORED bytes while a stale page cache is open", async () => {
    const { beginPageCache, readWikiPage } = await import("../wiki");
    const common = {
      owner: "alice",
      visibility: "private",
      authors: ["alice"],
      contributors: ["alice"],
    };
    await writeWikiPageWithSideEffects({
      slug: "cli-cached-update",
      title: "Cached update",
      content: serializeFrontmatter(
        { ...common, title: "Cached update" },
        "# Cached update\n\nOriginal body.",
      ),
      summary: "original",
      logOp: "ingest",
      crossRefSource: null,
    });
    const storedPath = (await readWikiPageWithFrontmatter("cli-cached-update"))!.path;

    const cleanup = beginPageCache();
    try {
      // A concurrent scan caches the current bytes.
      expect(await readWikiPage("cli-cached-update")).not.toBeNull();

      // A direct write supersedes them underneath the open cache, adding a key
      // that exists ONLY in storage.
      const storedBytes = serializeFrontmatter(
        { ...common, title: "Cached update", marker: "stored-only" },
        "# Cached update\n\nSuperseded body.",
      );
      await fs.writeFile(storedPath, storedBytes, "utf-8");
      // The cache is genuinely stale: a cached read still lacks the marker.
      expect(
        (await readWikiPageWithFrontmatter("cli-cached-update"))!.frontmatter.marker,
      ).toBeUndefined();

      await runUpdateWithStdin("cli-cached-update", "# Cached update\n\nNew body.");

      // THE ASSERTION THAT FAILS WITHOUT THE FRESH READ: the update merged over
      // the STORED frontmatter, so the stored-only marker survives.
      const after = await fs.readFile(storedPath, "utf-8");
      expect(after).toContain("marker: stored-only");
      expect(after).toContain("New body.");
    } finally {
      cleanup();
    }
  });

  /**
   * The CONTROL for the strict read: `strict` must still flatten a genuine
   * ENOENT into `null`, so a slug that was never written keeps answering the
   * established `not found` sentence rather than the new "could not read" one.
   * Only the mocked suite covers this today, and there the read is stubbed —
   * this row exercises the real `readWikiPageWithFrontmatter` against a real
   * empty store. (The create door already has real-fs coverage of the absent
   * path: the "rejects a create linking to a recreated merged slug" row above
   * only reaches the write because the guard answered `null`.)
   */
  it("runUpdate() still answers `not found` for a slug that was never written", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => { throw new Error("process.exit"); }) as unknown as () => never);

    await expect(runUpdateWithStdin("cli-absent-update", "# Absent\n\nNew body."))
      .rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(
      'Error: page "cli-absent-update" not found.\nRun "pnpm cli list" to see available pages.',
    );
    const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // An absent Page is not an unreadable one.
    expect(stderr).not.toContain("could not read page");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
