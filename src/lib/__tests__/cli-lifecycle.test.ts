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
});
