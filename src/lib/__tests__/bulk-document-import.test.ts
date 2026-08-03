import { describe, expect, it } from "vitest";
import {
  MAX_BULK_DOCUMENTS,
  documentExtension,
  formatDocumentBytes,
  runWithConcurrency,
  selectBulkDocuments,
} from "@/lib/bulk-document-import";
import { MAX_DOCUMENT_SIZE } from "@/lib/constants";

function file(name: string, size = 4, lastModified = 1): File {
  return new File([new Uint8Array(size)], name, { lastModified });
}

describe("bulk document import", () => {
  it("accepts supported documents and normalizes their extension", () => {
    const selection = selectBulkDocuments([
      file("brief.DOCX"),
      file("deck.pptx"),
      file("data.xlsx"),
      file("people.csv"),
      file("notes.md"),
      file("archive.zip"),
    ]);

    expect(selection.accepted).toHaveLength(6);
    expect(selection.rejected).toEqual([]);
    expect(documentExtension("brief.DOCX")).toBe("docx");
    expect(documentExtension("archive.zip")).toBe("zip");
  });

  it("rejects unsupported, empty, oversized, and duplicate files", () => {
    const existing = file("existing.csv", 5, 9);
    const selection = selectBulkDocuments(
      [
        file("malware.exe"),
        file("empty.csv", 0),
        file("large.docx", MAX_DOCUMENT_SIZE + 1),
        file("existing.csv", 5, 9),
      ],
      [existing],
    );

    expect(selection.accepted).toEqual([]);
    expect(selection.rejected.map((item) => item.reason).join(" ")).toMatch(
      /Markdown, TXT, HTML, PDF, DOCX, PPTX, XLSX, CSV, or ZIP/i,
    );
    expect(selection.rejected.map((item) => item.reason).join(" ")).toMatch(/empty/i);
    expect(selection.rejected.map((item) => item.reason).join(" ")).toMatch(/larger than 10 MB/i);
    expect(selection.rejected.map((item) => item.reason).join(" ")).toMatch(/already/i);
  });

  it("enforces the manifest cap after existing files", () => {
    const existing = Array.from({ length: MAX_BULK_DOCUMENTS - 1 }, (_, index) =>
      file(`existing-${index}.csv`, 1, index),
    );
    const selection = selectBulkDocuments(
      [file("last.csv", 1, 100), file("overflow.csv", 1, 101)],
      existing,
    );

    expect(selection.accepted.map((item) => item.name)).toEqual(["last.csv"]);
    expect(selection.rejected[0].reason).toMatch(
      new RegExp(`up to ${MAX_BULK_DOCUMENTS} files`, "i"),
    );
  });

  it("bounds upload concurrency without dropping work", async () => {
    let active = 0;
    let peak = 0;
    const completed: number[] = [];

    await runWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      completed.push(value);
      active -= 1;
    });

    expect(peak).toBe(2);
    expect(completed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("formats manifest sizes for people, not bytes", () => {
    expect(formatDocumentBytes(999)).toBe("999 B");
    expect(formatDocumentBytes(2048)).toBe("2 KB");
    expect(formatDocumentBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});
