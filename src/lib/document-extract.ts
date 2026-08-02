import { unzipSync } from "fflate";
import { MAX_CONTENT_LENGTH, MAX_DOCUMENT_SIZE } from "./constants";
import { ClientInputError } from "./errors";

export const DOCUMENT_FORMATS = ["docx", "pptx", "xlsx", "csv"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

const MAX_ARCHIVE_TEXT_BYTES = 12 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 6 * 1024 * 1024;
const MAX_SHEETS = 100;
const MAX_ROWS_PER_SHEET = 10_000;
const MAX_COLUMNS_PER_SHEET = 256;

const MIME_FORMATS: Record<string, DocumentFormat> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "application/csv": "csv",
};

export interface ExtractedDocument {
  format: DocumentFormat;
  title: string;
  text: string;
}

function extension(filename: string): string {
  const match = filename.trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

export function detectDocumentFormat(
  filename: string,
  contentType?: string,
): DocumentFormat | null {
  const ext = extension(filename);
  if (DOCUMENT_FORMATS.includes(ext as DocumentFormat)) {
    return ext as DocumentFormat;
  }
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mime ? MIME_FORMATS[mime] ?? null : null;
}

export function isSupportedDocument(filename: string, contentType?: string): boolean {
  return detectDocumentFormat(filename, contentType) !== null;
}

function decodeXml(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (entity, code: string) => {
      if (code[0] === "#") {
        const hex = code[1]?.toLowerCase() === "x";
        const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : entity;
      }
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[
        code.toLowerCase()
      ] ?? entity;
    },
  );
}

function xmlText(fragment: string, tagPattern: string): string[] {
  const values: string[] = [];
  const re = new RegExp(`<${tagPattern}\\b[^>]*>([\\s\\S]*?)<\\/${tagPattern}>`, "gi");
  for (const match of fragment.matchAll(re)) {
    const text = decodeXml(match[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (text) values.push(text);
  }
  return values;
}

function truncate(text: string): string {
  const trimmed = text.replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  return trimmed.length > MAX_CONTENT_LENGTH
    ? `${trimmed.slice(0, MAX_CONTENT_LENGTH - 25).trimEnd()}\n\n[Content truncated]`
    : trimmed;
}

function fallbackTitle(filename: string, label: string): string {
  return filename.replace(/\.(docx|pptx|xlsx|csv)$/i, "").trim() || label;
}

function coreTitle(files: Record<string, Uint8Array>): string | null {
  const core = files["docProps/core.xml"];
  if (!core) return null;
  return xmlText(new TextDecoder().decode(core), "dc:title")[0]?.slice(0, 200) ?? null;
}

function relevantArchiveEntry(format: Exclude<DocumentFormat, "csv">, name: string): boolean {
  if (name === "docProps/core.xml") return true;
  if (format === "docx") return name === "word/document.xml";
  if (format === "pptx") {
    return (
      name === "ppt/presentation.xml" ||
      name === "ppt/_rels/presentation.xml.rels" ||
      /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/i.test(name) ||
      /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/i.test(name)
    );
  }
  return (
    name === "xl/workbook.xml" ||
    name === "xl/_rels/workbook.xml.rels" ||
    name === "xl/sharedStrings.xml" ||
    /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)
  );
}

function openOfficeArchive(
  bytes: ArrayBuffer,
  format: Exclude<DocumentFormat, "csv">,
): Record<string, Uint8Array> {
  const input = new Uint8Array(bytes);
  if (input[0] !== 0x50 || input[1] !== 0x4b) {
    throw new ClientInputError(`The .${format} file is not a valid Office document.`);
  }
  let total = 0;
  try {
    return unzipSync(input, {
      filter(file) {
        if (!relevantArchiveEntry(format, file.name)) return false;
        if (file.originalSize > MAX_ARCHIVE_ENTRY_BYTES) {
          throw new ClientInputError(`The .${format} file contains an oversized XML part.`);
        }
        total += file.originalSize;
        if (total > MAX_ARCHIVE_TEXT_BYTES) {
          throw new ClientInputError(`The .${format} file expands beyond the safe extraction limit.`);
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ClientInputError) throw error;
    throw new ClientInputError(`The .${format} file could not be opened.`);
  }
}

function docxParagraph(fragment: string): string {
  const text = xmlText(fragment.replace(/<w:(tab|br)\b[^>]*\/?>/gi, " "), "w:t").join("");
  if (!text) return "";
  const style = fragment.match(/<w:pStyle\b[^>]*w:val=["']Heading([1-6])["']/i)?.[1];
  return style ? `${"#".repeat(Number(style))} ${text}` : text;
}

function docxTable(fragment: string): string {
  const rows: string[][] = [];
  for (const row of fragment.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gi)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gi)) {
      const value = Array.from(cell[1].matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gi))
        .map((match) => docxParagraph(match[0]))
        .filter(Boolean)
        .join(" ");
      cells.push(value);
    }
    if (cells.some(Boolean)) rows.push(cells);
  }
  return markdownTable(rows);
}

function extractDocx(files: Record<string, Uint8Array>): string {
  const document = files["word/document.xml"];
  if (!document) throw new ClientInputError("The DOCX file has no document body.");
  const xml = new TextDecoder().decode(document);
  const parts: string[] = [];
  for (const block of xml.matchAll(/<w:(p|tbl)\b[^>]*>[\s\S]*?<\/w:\1>/gi)) {
    const value = block[1].toLowerCase() === "tbl" ? docxTable(block[0]) : docxParagraph(block[0]);
    if (value) parts.push(value);
  }
  return parts.join("\n\n");
}

function numberedFiles(files: Record<string, Uint8Array>, pattern: RegExp): [number, Uint8Array][] {
  return Object.entries(files)
    .map(([name, value]) => [Number(name.match(pattern)?.[1] ?? 0), value] as [number, Uint8Array])
    .filter(([number]) => number > 0)
    .sort(([a], [b]) => a - b);
}

function resolveArchiveTarget(sourceFile: string, target: string): string | null {
  if (/^[a-z]+:/i.test(target) || target.startsWith("//")) return null;
  const parts = sourceFile.split("/");
  parts.pop();
  for (const part of target.replace(/^\//, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

function relationshipMap(xml: string, sourceFile: string): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const rel of xml.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gi)) {
    const id = attr(rel[1], "Id");
    const path = resolveArchiveTarget(sourceFile, attr(rel[1], "Target"));
    if (id && path) relationships.set(id, path);
  }
  return relationships;
}

function extractPptx(files: Record<string, Uint8Array>): string {
  const fallbackSlides = numberedFiles(files, /^ppt\/slides\/slide(\d+)\.xml$/i)
    .map(([number]) => ({ number, path: `ppt/slides/slide${number}.xml` }));
  let slides = fallbackSlides;
  const presentation = files["ppt/presentation.xml"];
  const presentationRels = files["ppt/_rels/presentation.xml.rels"];
  if (presentation && presentationRels) {
    const relationships = relationshipMap(
      new TextDecoder().decode(presentationRels),
      "ppt/presentation.xml",
    );
    const ordered = Array.from(
      new TextDecoder().decode(presentation).matchAll(/<p:sldId\b([^>]*)\/?>(?:<\/p:sldId>)?/gi),
    ).map((match, index) => ({
      number: index + 1,
      path: relationships.get(attr(match[1], "r:id")) ?? "",
    })).filter((slide) => Boolean(files[slide.path]));
    if (ordered.length) slides = ordered;
  }
  if (slides.length === 0) throw new ClientInputError("The PPTX file has no slides.");
  return slides.map(({ number, path }) => {
    const bytes = files[path];
    const xml = new TextDecoder().decode(bytes);
    const paragraphs = Array.from(xml.matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/gi))
      .map((match) => xmlText(match[0], "a:t").join(""))
      .filter(Boolean);
    const slideFilename = path.split("/").pop() ?? "";
    const relPath = `ppt/slides/_rels/${slideFilename}.rels`;
    const relBytes = files[relPath];
    const notePath = relBytes
      ? Array.from(
          relationshipMap(new TextDecoder().decode(relBytes), path).values(),
        ).find((target) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(target))
      : undefined;
    const noteBytes = notePath ? files[notePath] : undefined;
    const noteText = noteBytes
      ? xmlText(new TextDecoder().decode(noteBytes), "a:t").filter(
          (value) => value !== String(number),
        )
      : [];
    return [
      `## Slide ${number}`,
      paragraphs.join("\n"),
      noteText.length ? `### Speaker notes\n${noteText.join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  }).join("\n\n");
}

function attr(fragment: string, name: string): string {
  return fragment.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1] ?? "";
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const width = Math.min(MAX_COLUMNS_PER_SHEET, Math.max(...rows.map((row) => row.length)));
  const normalized = rows.map((row) =>
    Array.from({ length: width }, (_, index) => markdownCell(row[index] ?? "")),
  );
  const header = normalized[0];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}

function worksheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    if (rows.length >= MAX_ROWS_PER_SHEET) break;
    const values: string[] = [];
    for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const index = Math.min(MAX_COLUMNS_PER_SHEET - 1, columnIndex(attr(cell[1], "r")));
      const type = attr(cell[1], "t");
      const raw = xmlText(cell[2], "v")[0] ?? "";
      const value = type === "s"
        ? shared[Number(raw)] ?? ""
        : type === "inlineStr"
          ? xmlText(cell[2], "t").join("")
          : type === "b"
            ? raw === "1" ? "TRUE" : "FALSE"
            : raw;
      values[index] = value;
    }
    if (values.some((value) => value !== undefined && value !== "")) rows.push(values);
  }
  return rows;
}

function extractXlsx(files: Record<string, Uint8Array>): string {
  const sharedXml = files["xl/sharedStrings.xml"];
  const shared = sharedXml
    ? Array.from(new TextDecoder().decode(sharedXml).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi))
        .map((match) => xmlText(match[1], "t").join(""))
    : [];

  const workbook = files["xl/workbook.xml"];
  const relationships = files["xl/_rels/workbook.xml.rels"];
  const relationshipPaths = new Map<string, string>();
  if (relationships) {
    const xml = new TextDecoder().decode(relationships);
    for (const rel of xml.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gi)) {
      const id = attr(rel[1], "Id");
      const target = attr(rel[1], "Target").replace(/^\/?/, "");
      if (id && target && !target.includes("..")) {
        relationshipPaths.set(id, target.startsWith("xl/") ? target : `xl/${target}`);
      }
    }
  }

  const sheets: { name: string; path: string }[] = [];
  if (workbook) {
    const xml = new TextDecoder().decode(workbook);
    for (const sheet of xml.matchAll(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/gi)) {
      const name = decodeXml(attr(sheet[1], "name")) || `Sheet ${sheets.length + 1}`;
      const id = attr(sheet[1], "r:id");
      const path = relationshipPaths.get(id);
      if (path && files[path]) sheets.push({ name, path });
    }
  }
  if (sheets.length === 0) {
    for (const [number] of numberedFiles(files, /^xl\/worksheets\/sheet(\d+)\.xml$/i)) {
      sheets.push({ name: `Sheet ${number}`, path: `xl/worksheets/sheet${number}.xml` });
    }
  }
  if (sheets.length === 0) throw new ClientInputError("The XLSX file has no worksheets.");

  return sheets.slice(0, MAX_SHEETS).map(({ name, path }) => {
    const rows = worksheetRows(new TextDecoder().decode(files[path]), shared);
    return `## ${name}\n\n${markdownTable(rows) || "[Empty worksheet]"}`;
  }).join("\n\n");
}

export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < csv.length && rows.length < MAX_ROWS_PER_SHEET; i += 1) {
    const char = csv[i];
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value.length === 0) quoted = true;
    else if (char === ",") {
      if (row.length < MAX_COLUMNS_PER_SHEET) row.push(value);
      value = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && csv[i + 1] === "\n") i += 1;
      if (row.length < MAX_COLUMNS_PER_SHEET) row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else value += char;
  }
  if (quoted) throw new ClientInputError("The CSV file has an unterminated quoted field.");
  if (value || row.length) {
    if (row.length < MAX_COLUMNS_PER_SHEET) row.push(value);
    if (row.some((cell) => cell.trim())) rows.push(row);
  }
  return rows;
}

export function extractDocumentText(input: {
  bytes: ArrayBuffer;
  filename: string;
  contentType?: string;
}): ExtractedDocument {
  const { bytes, filename, contentType } = input;
  if (bytes.byteLength === 0) throw new ClientInputError("The document is empty.");
  if (bytes.byteLength > MAX_DOCUMENT_SIZE) {
    throw new ClientInputError(`Document too large (max ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB).`);
  }
  const format = detectDocumentFormat(filename, contentType);
  if (!format) {
    throw new ClientInputError("Unsupported document type. Upload a .docx, .pptx, .xlsx, or .csv file.");
  }

  if (format === "csv") {
    const csv = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
    const text = truncate(markdownTable(parseCsv(csv)));
    if (!text) throw new ClientInputError("The CSV file contains no rows.");
    return { format, title: fallbackTitle(filename, "CSV document"), text };
  }

  const files = openOfficeArchive(bytes, format);
  const extracted = format === "docx"
    ? extractDocx(files)
    : format === "pptx"
      ? extractPptx(files)
      : extractXlsx(files);
  const text = truncate(extracted);
  if (!text) throw new ClientInputError(`The .${format} file contains no extractable text.`);
  return {
    format,
    title: coreTitle(files) ?? fallbackTitle(filename, `${format.toUpperCase()} document`),
    text,
  };
}
