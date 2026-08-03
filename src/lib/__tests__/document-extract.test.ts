import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  detectDocumentFormat,
  extractDocumentText,
  parseCsv,
} from "@/lib/document-extract";

function office(filename: string, files: Record<string, string | Uint8Array>) {
  const zipped = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, value]) => [
        name,
        typeof value === "string" ? strToU8(value) : value,
      ]),
    ),
  );
  return extractDocumentText({
    bytes: Uint8Array.from(zipped).buffer,
    filename,
  });
}

describe("document extraction", () => {
  it("detects supported extensions and MIME types", () => {
    expect(detectDocumentFormat("report.DOCX")).toBe("docx");
    expect(detectDocumentFormat("upload", "text/csv; charset=utf-8")).toBe("csv");
    expect(detectDocumentFormat("archive.zip")).toBeNull();
  });

  it("extracts DOCX headings, paragraphs, tables, entities, and core title", () => {
    const result = office("fallback.docx", {
      "docProps/core.xml": "<cp:coreProperties><dc:title>Quarterly Plan</dc:title><dc:creator>Christian</dc:creator><dcterms:created>2026-08-01T12:00:00Z</dcterms:created></cp:coreProperties>",
      "word/document.xml": `<w:document><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Overview &amp; goals</w:t></w:r></w:p>
        <w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Task</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>Chris</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Ship</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:body></w:document>`,
    });
    expect(result).toMatchObject({ format: "docx", title: "Quarterly Plan" });
    expect(result.text).toContain("# Overview & goals");
    expect(result.text).toContain("| Owner | Task |");
    expect(result.text).toContain("| Chris | Ship |");
    expect(result.text).toContain("Created: 2026-08-01T12:00:00Z");
    expect(result.metadata).toMatchObject({ creator: "Christian" });
  });

  it("preserves DOCX embedded images with their relationship and context", () => {
    const result = office("illustrated.docx", {
      "word/document.xml": '<w:document><w:body><w:p><w:r><w:t>Diagram</w:t></w:r><w:r><w:drawing><wp:inline><wp:docPr name="Architecture" descr="System architecture"/><a:graphic><a:blip r:embed="rId7"/></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>',
      "word/_rels/document.xml.rels": '<Relationships><Relationship Id="rId7" Target="media/diagram.png"/></Relationships>',
      "word/media/diagram.png": new Uint8Array([137, 80, 78, 71]),
    });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      filename: "diagram.png",
      mediaType: "image/png",
      alt: "System architecture",
      context: "Paragraph 1",
    });
    expect(Array.from(new Uint8Array(result.assets[0].bytes))).toEqual([137, 80, 78, 71]);
    expect(result.text).toContain("Embedded image: System architecture");
  });

  it("extracts PPTX slides in presentation order with linked speaker notes", () => {
    const result = office("deck.pptx", {
      "ppt/presentation.xml": '<p:presentation><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>',
      "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
      "ppt/slides/slide2.xml": '<p:sld><p:cNvPr name="Photo" descr="Launch photo"/><a:p><a:r><a:t>Second slide</a:t></a:r></a:p><a:blip r:embed="image1"/></p:sld>',
      "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>",
      "ppt/slides/_rels/slide2.xml.rels": '<Relationships><Relationship Id="notes" Target="../notesSlides/notesSlide1.xml"/><Relationship Id="image1" Target="../media/photo.jpg"/></Relationships>',
      "ppt/media/photo.jpg": new Uint8Array([255, 216, 255]),
      "ppt/notesSlides/notesSlide1.xml": "<p:notes><a:p><a:r><a:t>Explain this</a:t></a:r></a:p></p:notes>",
    });
    expect(result.text.indexOf("Second slide")).toBeLessThan(result.text.indexOf("First slide"));
    expect(result.text).toContain("### Speaker notes");
    expect(result.text).toContain("Explain this");
    expect(result.text).toContain("### Embedded images");
    expect(result.assets).toEqual([
      expect.objectContaining({
        filename: "photo.jpg",
        alt: "Launch photo",
        context: "Slide 1",
      }),
    ]);
  });

  it("extracts XLSX shared strings, inline strings, values, and sheet names", () => {
    const result = office("metrics.xlsx", {
      "xl/workbook.xml": '<workbook><sheets><sheet name="Metrics" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml": "<sst><si><t>Name</t></si><si><t>Value</t></si><si><t>Revenue</t></si></sst>",
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
        <row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
        <row><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>
        <row><c r="A3" t="inlineStr"><is><t>Status</t></is></c><c r="B3" t="b"><v>1</v></c></row>
      </sheetData></worksheet>`,
    });
    expect(result.text).toContain("## Metrics");
    expect(result.text).toContain("| Name | Value |");
    expect(result.text).toContain("| Revenue | 42 |");
    expect(result.text).toContain("| Status | TRUE |");
  });

  it("parses quoted CSV fields, escaped quotes, and embedded newlines", () => {
    expect(parseCsv('name,note\r\nAlice,"hello, world"\r\nBob,"said ""yes""\nagain"')).toEqual([
      ["name", "note"],
      ["Alice", "hello, world"],
      ["Bob", 'said "yes"\nagain'],
    ]);
    const bytes = new TextEncoder().encode("name,total\nAlpha,10");
    const result = extractDocumentText({ bytes: bytes.buffer, filename: "report.csv" });
    expect(result.text).toContain("| name | total |");
    expect(result.text).toContain("| Alpha | 10 |");
  });

  it("rejects unsupported, corrupt, and empty documents", () => {
    const bytes = new TextEncoder().encode("not a zip");
    expect(() => extractDocumentText({ bytes: bytes.buffer, filename: "a.docx" })).toThrow(/not a valid/i);
    expect(() => extractDocumentText({ bytes: bytes.buffer, filename: "a.zip" })).toThrow(/unsupported/i);
    expect(() => extractDocumentText({ bytes: new ArrayBuffer(0), filename: "a.csv" })).toThrow(/empty/i);
  });
});
