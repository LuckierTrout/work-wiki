import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { serializeFrontmatter } from "../frontmatter";
import { buildPortableArchive, importPortableArchive, inspectPortableArchive } from "../portable-archive";
import { _resetStorage, getStorage } from "../storage";
import { listWikiPages, updateIndex, writeWikiPage } from "../wiki";

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
    expect(archive.manifest.format).toBe("workwiki-portable-archive");
    const tenantFiles = archive.manifest.files.filter((entry) => !entry.path.startsWith(".obsidian/"));
    expect(tenantFiles).toHaveLength(2);
    expect(archive.manifest.files.some((entry) => entry.path === ".obsidian/app.json")).toBe(true);
    expect((await inspectPortableArchive("alice", buffer(archive.bytes))).collisions).toHaveLength(2);

    await getStorage().deleteDirectory("tenants/alice");
    const preview = await inspectPortableArchive("alice", buffer(archive.bytes));
    expect(preview.newFiles.length).toBeGreaterThanOrEqual(2);
    const result = await importPortableArchive("alice", buffer(archive.bytes), "skip");
    expect(result.imported).toBe(archive.manifest.files.length);
    expect(result.skipped).toBe(0);
    expect(await getStorage().readFile("tenants/alice/wiki/atlas.md")).toBe(page);
    expect(await getStorage().readFile("wiki/atlas.md")).toBe(page);
  });

  it("generates .obsidian/ and keeps the frozen format string", async () => {
    const page = serializeFrontmatter(
      { owner: "alice", visibility: "private", authors: ["alice"] },
      "# Atlas\n\nPrivate knowledge.",
    );
    await getStorage().writeFile("tenants/alice/wiki/atlas.md", page);
    await getStorage().writeFile("tenants/alice/action-items.json", "[]");
    await getStorage().writeFile("tenants/alice/chat-conversations.json", "[]");
    await getStorage().writeFile("tenants/alice/todos.json", '{"items":[]}');
    await getStorage().writeFile("tenants/alice/research-projects.json", "[]");
    const archive = await buildPortableArchive("alice");
    expect(archive.manifest.format).toBe("workwiki-portable-archive");
    const names = archive.manifest.files.map((entry) => entry.path);
    expect(names).toContain(".obsidian/app.json");
    expect(names).toContain(".obsidian/appearance.json");
    expect(names).toContain(".obsidian/core-plugins.json");
    expect(names).toContain("action-items.json");
    expect(names).toContain("chat-conversations.json");
    expect(names).toContain("todos.json");
    expect(names).toContain("research-projects.json");
    expect(names.every((name) => !name.includes("todos.md"))).toBe(true);
  });

  it("excludes rebuilt and append-only wiki infrastructure from exports", async () => {
    await getStorage().writeFile("tenants/alice/wiki/index.md", "# Index\n");
    await getStorage().writeFile("tenants/alice/wiki/log.md", "audit\n");

    const archive = await buildPortableArchive("alice");
    const names = archive.manifest.files.map((entry) => entry.path);

    expect(names).not.toContain("wiki/index.md");
    expect(names).not.toContain("wiki/log.md");
  });

  it.each(["wiki/index.md", "wiki/log.md"])(
    "rejects imported infrastructure %s before storage mutation",
    async (infrastructurePath) => {
      await getStorage().writeFile("tenants/alice/settings.json", "{}");
      const archive = await buildPortableArchive("alice");
      const files = unzipSync(archive.bytes);
      const bytes = strToU8("attacker-controlled infrastructure\n");
      const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
      manifest.files.push({
        path: infrastructurePath,
        size: bytes.byteLength,
        sha256: await digest(buffer(bytes)),
      });
      files[`files/${infrastructurePath}`] = bytes;
      files["manifest.json"] = strToU8(JSON.stringify(manifest));

      await expect(importPortableArchive("alice", buffer(zipSync(files)), "overwrite"))
        .rejects.toThrow(/wiki infrastructure/i);
      await expect(getStorage().fileExists(`tenants/alice/${infrastructurePath}`))
        .resolves.toBe(false);
      await expect(getStorage().fileExists(infrastructurePath)).resolves.toBe(false);
    },
  );

  it("refuses to restore an archive into another owner tenant", async () => {
    await getStorage().writeFile("tenants/alice/settings.json", "{}");
    const archive = await buildPortableArchive("alice");
    await expect(inspectPortableArchive("bob", buffer(archive.bytes))).rejects.toThrow(/different owner/i);
  });

  it("round-trips a nested queries Page through ownership checks and index rebuild", async () => {
    const page = serializeFrontmatter(
      { owner: "alice", visibility: "private", authors: ["alice"] },
      "# Saved answer\n\nPrivate answer.",
    );
    await getStorage().writeFile("tenants/alice/wiki/queries/saved-answer.md", page);
    const archive = await buildPortableArchive("alice");
    await getStorage().deleteDirectory("tenants/alice");

    await importPortableArchive("alice", buffer(archive.bytes), "overwrite");

    expect(await getStorage().readFile("tenants/alice/wiki/queries/saved-answer.md")).toBe(page);
    expect(await getStorage().readFile("wiki/queries/saved-answer.md")).toBe(page);
    expect(await listWikiPages({ strict: true })).toContainEqual(
      expect.objectContaining({ slug: "queries/saved-answer", owner: "alice" }),
    );
  });

  it("rejects foreign-owner Page bytes before mutating either storage path", async () => {
    const foreign = serializeFrontmatter(
      { owner: "bob", visibility: "private" },
      "# Foreign\n\nBob.",
    );
    await getStorage().writeFile("tenants/alice/wiki/queries/foreign.md", foreign);
    const archive = await buildPortableArchive("alice");
    await getStorage().deleteDirectory("tenants/alice");

    await expect(importPortableArchive("alice", buffer(archive.bytes), "overwrite"))
      .rejects.toThrow(/owner.*archive tenant/i);
    await expect(getStorage().fileExists("tenants/alice/wiki/queries/foreign.md"))
      .resolves.toBe(false);
    await expect(getStorage().fileExists("wiki/queries/foreign.md"))
      .resolves.toBe(false);
  });

  it("refuses a nested queries Page already owned by another tenant", async () => {
    const alice = serializeFrontmatter(
      { owner: "alice", visibility: "private" },
      "# Saved answer\n\nAlice.",
    );
    await getStorage().writeFile("tenants/alice/wiki/queries/saved-answer.md", alice);
    const archive = await buildPortableArchive("alice");
    await getStorage().deleteDirectory("tenants/alice");
    const bob = serializeFrontmatter(
      { owner: "bob", visibility: "private" },
      "# Saved answer\n\nBob.",
    );
    await writeWikiPage("queries/saved-answer", bob);
    await updateIndex([{ slug: "queries/saved-answer", title: "Saved answer", summary: "Bob", owner: "bob" }]);

    await expect(importPortableArchive("alice", buffer(archive.bytes), "overwrite"))
      .rejects.toThrow(/another owner/i);
  });
});

function buffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function digest(value: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
