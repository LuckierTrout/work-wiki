import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  listDocumentSources,
  preserveDocumentSources,
} from "@/lib/document-sources";
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
      relativePath: "Planning/Q1/Quarterly Plan.docx",
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
    expect(result[0].relativePath).toBe("Planning/Q1/Quarterly Plan.docx");
    expect(await listDocumentSources("source", "Alice")).toEqual(result);
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

// ---------------------------------------------------------------------------
// An UNREADABLE page is not an ABSENT one (DW-495)
// ---------------------------------------------------------------------------

/**
 * `appendSourceFigures` reads the page to get the figure-append merge base and
 * already throws on `null` — but under the sentence
 * `Cannot attach document figures: page "<slug>" was not found.` Without
 * `strict` a non-ENOENT storage failure came back as that same `null`, so a
 * page that is stored and only momentarily unreadable was reported to the
 * caller as missing. Strict rethrows the storage failure instead.
 */
describe("preserveDocumentSources — unreadable ≠ absent (DW-495)", () => {
  it("rejects with the STORAGE error, not `was not found`, when the page read blips", async () => {
    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    // A non-ENOENT failure on `source.md`: the file is there (the global
    // `beforeEach` wrote it), the provider is not.
    const readSpy = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (filePath: string) => {
        if (filePath.endsWith("source.md")) {
          throw new Error("storage unavailable");
        }
        return originalRead(filePath);
      });

    let caught: unknown;
    try {
      await preserveDocumentSources("source", "Alice", [{
        bytes: new Uint8Array([80, 75, 3, 4]).buffer,
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
    } catch (err) {
      caught = err;
    } finally {
      readSpy.mockRestore();
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("storage unavailable");
    expect(message).not.toContain("was not found");

    // Nothing was appended to the stored page.
    const page = await readWikiPageWithFrontmatter("source");
    expect(page?.body).not.toContain("## Source figures");
  });
});
