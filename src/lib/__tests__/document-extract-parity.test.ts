import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  detectDocumentFormat,
  extractDocumentText,
  rawPixelsToPng,
} from "../document-extract";

function buffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

describe("document format parity", () => {
  it("detects OpenDocument, ebook, Org, RTF, and MOBI formats", () => {
    expect(detectDocumentFormat("notes.odt")).toBe("odt");
    expect(detectDocumentFormat("deck.odp")).toBe("odp");
    expect(detectDocumentFormat("table.ods")).toBe("ods");
    expect(detectDocumentFormat("book.epub")).toBe("epub");
    expect(detectDocumentFormat("notes.org")).toBe("org");
    expect(detectDocumentFormat("legacy.rtf")).toBe("rtf");
    expect(detectDocumentFormat("book.mobi")).toBe("mobi");
  });

  it("extracts ODT and EPUB archives without native binaries", () => {
    const odt = zipSync({
      "content.xml": strToU8('<office:document><text:h text:outline-level="1">Plan</text:h><text:p>Launch in June.</text:p></office:document>'),
      "meta.xml": strToU8("<office:meta><dc:title>Launch Plan</dc:title><dc:creator>Alice</dc:creator></office:meta>"),
    });
    expect(extractDocumentText({ bytes: buffer(odt), filename: "plan.odt" })).toMatchObject({
      format: "odt", title: "Launch Plan", text: expect.stringContaining("Launch in June"),
    });

    const epub = zipSync({
      "book.opf": strToU8("<package><dc:title>Field Guide</dc:title><dc:creator>Alice</dc:creator></package>"),
      "chapter-1.xhtml": strToU8("<html><body><h1>Opening</h1><p>Evidence first.</p></body></html>"),
    });
    expect(extractDocumentText({ bytes: buffer(epub), filename: "guide.epub" })).toMatchObject({
      format: "epub", title: "Field Guide", text: expect.stringContaining("Evidence first"),
    });
  });

  it("converts RTF control words and raw PDF pixels safely", () => {
    const rtf = new TextEncoder().encode("{\\rtf1\\ansi Project\\par Launch \\'96 June}");
    const extracted = extractDocumentText({ bytes: buffer(rtf), filename: "project.rtf" });
    expect(extracted.text).toContain("Project");
    expect(extracted.text).toContain("Launch – June");

    const png = new Uint8Array(rawPixelsToPng({
      data: new Uint8ClampedArray([255, 0, 0, 255]), width: 1, height: 1, channels: 4,
    }));
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(new TextDecoder().decode(png.slice(12, 16))).toBe("IHDR");
  });
});
