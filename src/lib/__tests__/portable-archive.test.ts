import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serializeFrontmatter } from "../frontmatter";
import { buildPortableArchive, importPortableArchive, inspectPortableArchive } from "../portable-archive";
import { _resetStorage, getStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "portable-archive-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("portable owner archive", () => {
  it("round-trips tenant files with checksums and rebuilds compatibility paths", async () => {
    const page = serializeFrontmatter({ owner: "alice", visibility: "private", authors: ["alice"] }, "# Atlas\n\nPrivate knowledge.");
    await getStorage().writeFile("tenants/alice/wiki/atlas.md", page);
    await getStorage().writeAsset("tenants/alice/raw/atlas/source.bin", new Uint8Array([1, 2, 3]).buffer);
    const archive = await buildPortableArchive("alice");
    expect(archive.manifest.files).toHaveLength(2);
    expect((await inspectPortableArchive("alice", buffer(archive.bytes))).collisions).toHaveLength(2);

    await getStorage().deleteDirectory("tenants/alice");
    const preview = await inspectPortableArchive("alice", buffer(archive.bytes));
    expect(preview.newFiles).toHaveLength(2);
    const result = await importPortableArchive("alice", buffer(archive.bytes), "skip");
    expect(result).toMatchObject({ imported: 2, skipped: 0 });
    expect(await getStorage().readFile("tenants/alice/wiki/atlas.md")).toBe(page);
    expect(await getStorage().readFile("wiki/atlas.md")).toBe(page);
  });

  it("refuses to restore an archive into another owner tenant", async () => {
    await getStorage().writeFile("tenants/alice/settings.json", "{}");
    const archive = await buildPortableArchive("alice");
    await expect(inspectPortableArchive("bob", buffer(archive.bytes))).rejects.toThrow(/different owner/i);
  });
});

function buffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
