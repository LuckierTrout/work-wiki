import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { extractDocumentText, extractDocumentTextAsync } from "../document-extract";
import { ClientInputError } from "../errors";

const worksheet = (value: string) => `<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>${value}</t></is></c></row></sheetData></worksheet>`;
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])));
const extract = (files: Record<string, string>) => extractDocumentText({ filename: "metrics.xlsx", bytes: Uint8Array.from(zip(files)).buffer });
function fixture(target = "sharedStrings.xml", attributes = "") {
  return {
    "xl/workbook.xml": '<workbook><sheets><sheet name="Bogus" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="${target}" ${attributes}/></Relationships>`,
    "xl/sharedStrings.xml": '<sst><si><t>Not a worksheet</t></si></sst>',
    "xl/worksheets/sheet1.xml": worksheet("Actual metrics"),
  };
}

describe("XLSX worksheet identity through extraction entry points", () => {
  it("a real shared-string member cannot suppress the numbered worksheet fallback", () => {
    const files = fixture();
    const result = extract(files).text;
    expect(result).toContain("## Sheet 1");
    expect(result).toContain("Actual metrics");
    expect(result).not.toMatch(/## Bogus|Empty worksheet/);
  });

  it("keeps valid relationship names/order and drops a non-worksheet among them", () => {
    const files = fixture();
    files["xl/workbook.xml"] = '<workbook><sheets><sheet name="Bogus" r:id="rId1"/><sheet name="Second" r:id="rId2"/><sheet name="First" r:id="rId3"/></sheets></workbook>';
    files["xl/_rels/workbook.xml.rels"] = '<Relationships><Relationship Id="rId1" Target="sharedStrings.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/><Relationship Id="rId3" Target="worksheets/sheet1.xml"/></Relationships>';
    const result = extract({ ...files, "xl/worksheets/sheet2.xml": worksheet("Quarterly metrics") }).text;
    expect(result.indexOf("## Second")).toBeLessThan(result.indexOf("## First"));
    expect(result).toContain("Quarterly metrics");
    expect(result).toContain("Actual metrics");
    expect(result).not.toMatch(/Bogus|Empty worksheet/);
  });

  it.each(['Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet"', 'TargetMode="External"'])("does not label an unsupported relationship as a worksheet: %s", (attributes) => {
    const result = extract(fixture("worksheets/sheet1.xml", attributes)).text;
    expect(result).toContain("## Sheet 1");
    expect(result).toContain("Actual metrics");
    expect(result).not.toContain("## Bogus");
  });

  it("retains actual fallback bytes for case-variant archive member names", () => {
    const files: Record<string, string> = fixture();
    delete files["xl/worksheets/sheet1.xml"];
    files["xl/Worksheets/Sheet2.xml"] = worksheet("Case-sensitive archive");
    expect(extract(files).text).toContain("Case-sensitive archive");
  });

  it("reports no worksheets when only unrelated parts exist", () => {
    const files: Record<string, string> = fixture();
    delete files["xl/worksheets/sheet1.xml"];
    expect(() => extract(files)).toThrow(ClientInputError);
    expect(() => extract(files)).toThrow("no worksheets");
  });

  it("preserves a genuinely empty worksheet", () => {
    const files = fixture("worksheets/sheet1.xml");
    files["xl/worksheets/sheet1.xml"] = "<worksheet><sheetData/></worksheet>";
    expect(extract(files).text).toContain("## Bogus\n\n[Empty worksheet]");
  });

  it("extracts real sheet data through the inline nested ZIP door", async () => {
    const bytes = zipSync({ "reports/metrics.xlsx": zip(fixture()) });
    const result = await extractDocumentTextAsync({ filename: "reports.zip", bytes: Uint8Array.from(bytes).buffer });
    expect(result.text).toContain("## File: reports/metrics.xlsx");
    expect(result.text).toContain("Actual metrics");
    expect(result.text).not.toMatch(/## Bogus|Empty worksheet/);
  });
});
