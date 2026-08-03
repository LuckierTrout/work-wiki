import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { preserveDocumentSources } from "@/lib/document-sources";
import { serializeFrontmatter } from "@/lib/frontmatter";
import { _resetStorage, getStorage } from "@/lib/storage";
import { readWikiPageWithFrontmatter, wikiRelPath } from "@/lib/wiki";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "document-sources-test-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  await getStorage().writeFile(
    wikiRelPath("source.md"),
    serializeFrontmatter(
      { owner: "alice", visibility: "public", authors: ["alice"] },
      "# Source\n\nA source page.",
    ),
  );
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("document source preservation", () => {
  it("stores the original under an owner scope and appends embedded figures once", async () => {
    const original = new Uint8Array([80, 75, 3, 4]).buffer;
    const result = await preserveDocumentSources("source", "Alice", [{
      bytes: original,
      filename: "Quarterly Plan.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extracted: {
        format: "docx",
        title: "Quarterly Plan",
        text: "Plan",
        metadata: {},
        assets: [{
          filename: "diagram.png",
          mediaType: "image/png",
          bytes: new Uint8Array([137, 80, 78, 71]).buffer,
          alt: "Architecture diagram",
          context: "Paragraph 2",
        }],
      },
    }]);

    expect(result[0].originalKey).toMatch(/^raw\/originals\/alice\/source\//);
    expect(new Uint8Array(await getStorage().readAsset(result[0].originalKey))).toEqual(
      new Uint8Array(original),
    );
    const page = await readWikiPageWithFrontmatter("source");
    expect(page?.body).toContain("## Source figures");
    expect(page?.body).toContain("Architecture diagram");
    expect(page?.body).toContain(result[0].assets[0].publicPath);

    await preserveDocumentSources("source", "Alice", [{
      bytes: original,
      filename: "Quarterly Plan.docx",
      extracted: {
        format: "docx",
        title: "Quarterly Plan",
        text: "Plan",
        metadata: {},
        assets: [{
          filename: "diagram.png",
          mediaType: "image/png",
          bytes: new Uint8Array([137, 80, 78, 71]).buffer,
          alt: "Architecture diagram",
          context: "Paragraph 2",
        }],
      },
    }]);
    const updated = await readWikiPageWithFrontmatter("source");
    expect(updated?.body.match(/Architecture diagram/g)).toHaveLength(1);
  });
});
