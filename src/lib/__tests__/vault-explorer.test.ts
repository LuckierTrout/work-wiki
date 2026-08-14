import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { serializeFrontmatter } from "@/lib/frontmatter";
import { _resetStorage, getStorage } from "@/lib/storage";
import { getVaultExplorerEntries } from "@/lib/vault-explorer";
import type { Vault } from "@/lib/vault";
import { wikiRelPath } from "@/lib/wiki";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-explorer-test-"));
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

describe("getVaultExplorerEntries", () => {
  it("omits unreadable pages even when an old vault reference remains", async () => {
    await Promise.all([
      getStorage().writeFile(
        wikiRelPath("public-note.md"),
        serializeFrontmatter(
          { owner: "bob", visibility: "public" },
          "# Public note\n\nVisible",
        ),
      ),
      getStorage().writeFile(
        wikiRelPath("private-note.md"),
        serializeFrontmatter(
          { owner: "bob", visibility: "private" },
          "# Private note\n\nHidden",
        ),
      ),
    ]);
    const vault: Vault = {
      id: "alice--work",
      owner: "alice",
      name: "Work",
      visibility: "public",
      slugs: ["public-note", "private-note"],
      created: "2026-01-01T00:00:00.000Z",
    };

    const entries = await getVaultExplorerEntries(vault, {
      id: "user_1",
      handle: "alice",
    });

    expect(entries.map((entry) => entry.slug)).toEqual(["public-note"]);
  });
});
