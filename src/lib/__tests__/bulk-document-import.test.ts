import { describe, expect, it } from "vitest";
import {
  ACCEPTED_DOCUMENT_ATTRIBUTE,
  MAX_BULK_DOCUMENTS,
  documentExtension,
  formatDocumentBytes,
  runWithConcurrency,
  selectBulkDocuments,
} from "@/lib/bulk-document-import";
import { MAX_DOCUMENT_SIZE } from "@/lib/constants";
import {
  DOCUMENT_FORMAT_LABELS,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  SUPPORTED_DOCUMENT_MIME_TYPES,
  isSupportedDocument,
} from "@/lib/document-formats";

function file(name: string, size = 4, lastModified = 1, type = ""): File {
  return new File([new Uint8Array(size)], name, { lastModified, type });
}

const sorted = (values: readonly string[]) => [...values].sort();

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
    // The format sentence is asserted against derived labels in its own case
    // below; here only that the unsupported file is the one that got it.
    expect(selection.rejected[0].reason).toMatch(
      new RegExp(DOCUMENT_FORMAT_LABELS.docx),
    );
    expect(selection.rejected.map((item) => item.reason).join(" ")).toMatch(/empty/i);
    expect(selection.rejected.map((item) => item.reason).join(" ")).toMatch(/larger than 10 MB/i);
    expect(selection.rejected.map((item) => item.reason).join(" ")).toMatch(/already/i);
  });

  /**
   * Allowlist parity with `/api/ingest/document` (DW-246).
   *
   * This module used to declare its own eleven-entry `SUPPORTED_EXTENSIONS`,
   * seven formats behind what the endpoint accepts, so `plan.odt` was refused
   * client-side even though POSTing it succeeds. The assertions below are
   * derived from `@/lib/document-formats` — the same tables the endpoint's
   * `detectDocumentFormat` consults — because a literal restated here would
   * have to be edited alongside the very drift it exists to catch.
   */
  it("accepts every extension the ingest endpoint accepts", () => {
    const selection = selectBulkDocuments(
      SUPPORTED_DOCUMENT_EXTENSIONS.map((ext, index) =>
        file(`doc-${index}.${ext}`, 4, index),
      ),
    );

    expect(
      selection.rejected.map((item) => item.file.name),
      "extensions the server accepts but bulk import refuses",
    ).toEqual([]);
    expect(selection.accepted).toHaveLength(SUPPORTED_DOCUMENT_EXTENSIONS.length);
  });

  it("accepts an OpenDocument drag and badges its real extension", () => {
    const selection = selectBulkDocuments([file("plan.odt")]);

    expect(selection.rejected).toEqual([]);
    expect(selection.accepted.map((item) => item.name)).toEqual(["plan.odt"]);
    expect(documentExtension("plan.odt")).toBe("odt");
  });

  it("keeps an alias extension as its own display token", () => {
    // `markdown` resolves to the `md` FORMAT server-side, but the manifest badge
    // shows what the user actually dropped.
    expect(documentExtension("notes.MARKDOWN")).toBe("markdown");
    expect(documentExtension("page.HTM")).toBe("htm");
  });

  /**
   * Detection parity, not just table parity (DW-246).
   *
   * Sharing `SUPPORTED_DOCUMENT_EXTENSIONS` but keeping a local
   * `split(".").pop()` left the client disagreeing with the server on two real
   * filenames — the same client-refuses-what-the-server-accepts failure, one
   * layer down from the allowlist. Both directions are wrong: a false accept
   * queues a file that 400s mid-upload, a false reject hides a supported one.
   */
  it.each([
    // No dot at all: `split(".").pop()` answers the WHOLE NAME, so this used to
    // pass client validation and then 400 at /api/ingest/document.
    ["org", false],
    ["md", false],
    ["csv", false],
    // Trailing space: the endpoint trims before matching, the old client did
    // not, so this was refused here and accepted there.
    ["notes.md ", true],
    [" plan.odt", true],
    // Unchanged behaviour, pinned so the shared helper cannot regress it.
    ["plan.odt", true],
    ["notes.MARKDOWN", true],
    ["malware.exe", false],
  ] as const)(
    "agrees with the ingest endpoint about %s",
    (name, serverAccepts) => {
      expect(isSupportedDocument(name)).toBe(serverAccepts);

      // THE GATE, not the badge. `documentExtension` used to be both — the
      // manifest token AND what `validationError` branched on — so reading it
      // here was reading the client's decision. Since DW-347 the gate is
      // `isSupportedDocument(name, type)` and `documentExtension` only chooses
      // a label, so a client/server disagreement would no longer show up in it.
      const { accepted, rejected } = selectBulkDocuments([file(name)]);
      expect(
        accepted.length === 1,
        `client and server disagree about "${name}"`,
      ).toBe(serverAccepts);
      expect(rejected).toHaveLength(serverAccepts ? 0 : 1);
    },
  );

  /**
   * The MIME arm of the same parity claim (DW-347).
   *
   * `ACCEPTED_DOCUMENT_ATTRIBUTE` offers the browser 21 content types as well
   * as the extensions, so the picker admits files the filename alone cannot
   * identify — a download saved as `report` with `type: "application/pdf"` is
   * the ordinary case, not a contrived one. The gate branched on the extension
   * alone, so those were refused here and accepted by `/api/ingest/document`:
   * the DW-246 failure again, one arm over.
   *
   * The rows carry the badge too, because "accepted" is only half of what the
   * user sees — a file queued under a `file` badge looks like the manifest did
   * not recognize it.
   */
  it.each([
    // No extension at all: only the MIME arm can identify these.
    ["report", "application/pdf", true, "pdf"],
    ["spreadsheet", "text/csv", true, "csv"],
    // Parameterized content types are what a real picker hands over.
    ["notes", "text/markdown; charset=utf-8", true, "md"],
    // Offered by nothing: neither arm matches, so both sides refuse.
    ["blob", "application/x-msdownload", false, "file"],
    ["malware.exe", "application/x-msdownload", false, "file"],
    // PRECEDENCE, in the direction that actually widens the gate: an
    // unsupported extension no longer decides the answer on its own. `.exe`
    // fails the extension arm, `text/plain` passes the MIME arm, and the file
    // is accepted and badged `txt` — which is exactly what
    // `/api/ingest/document` does with the same two values, so the widening is
    // parity rather than a hole. (The two rows above use a content type that
    // fails BOTH arms, so they say nothing about which arm ran.)
    ["malware.exe", "text/plain", true, "txt"],
    // The extension arm still WINS: the badge shows what the user dropped, not
    // the format the MIME type would have resolved to.
    ["notes.MARKDOWN", "text/plain", true, "markdown"],
    ["plan.odt", "application/pdf", true, "odt"],
    // An empty `type` is what `new File` gives with no options, and what a
    // drag-and-drop of an unknown format often carries: extension arm only.
    ["notes.md", "", true, "md"],
    ["mystery", "", false, "file"],
  ] as const)(
    "agrees with the ingest endpoint about %s (%s)",
    (name, type, serverAccepts, badge) => {
      expect(isSupportedDocument(name, type)).toBe(serverAccepts);

      const { accepted, rejected } = selectBulkDocuments([
        file(name, 4, 1, type),
      ]);
      expect(
        accepted.length === 1,
        `client and server disagree about "${name}" (${type})`,
      ).toBe(serverAccepts);
      expect(rejected).toHaveLength(serverAccepts ? 0 : 1);
      if (!serverAccepts) {
        // `toContain`, not `new RegExp(label)`: the labels are data, and one
        // containing a regex metacharacter (`C++`, `Objective-C#`) would turn a
        // substring check into a pattern match — or a syntax error.
        expect(rejected[0].reason).toContain(DOCUMENT_FORMAT_LABELS.pdf);
      }

      expect(documentExtension(name, type)).toBe(badge);
    },
  );

  /**
   * The MIME arm swept, not sampled — the symmetric twin of "accepts every
   * extension the ingest endpoint accepts" above.
   *
   * `ACCEPTED_DOCUMENT_ATTRIBUTE` puts all of `SUPPORTED_DOCUMENT_MIME_TYPES`
   * into the picker's filter, so every one of them is a type the browser will
   * hand over — under an extension-less name whenever the download had no
   * extension to begin with. A hand-picked row or three cannot pin that: the
   * gap DW-246 and DW-347 are both about is a list falling behind, and only a
   * loop over the list itself notices when it does. `EXTENSION_ALIASES` needs
   * no counterpart here; the MIME table has no aliases, every key maps
   * straight to a format.
   */
  it("queues an extension-less file for every MIME type the picker advertises", () => {
    const advertised = new Set(ACCEPTED_DOCUMENT_ATTRIBUTE.split(","));

    const unqueueable = SUPPORTED_DOCUMENT_MIME_TYPES.filter((mime, index) => {
      const { accepted } = selectBulkDocuments([
        file(`download-${index}`, 4, index, mime),
      ]);
      return accepted.length !== 1;
    });

    expect(
      unqueueable,
      `content types the picker offers but the manifest refuses: ${unqueueable.join(", ")}`,
    ).toEqual([]);
    // And the picker really does offer each of them — otherwise the loop above
    // is pinning acceptance of types no user can select.
    expect(
      SUPPORTED_DOCUMENT_MIME_TYPES.filter((mime) => !advertised.has(mime)),
    ).toEqual([]);
    expect(SUPPORTED_DOCUMENT_MIME_TYPES.length).toBeGreaterThan(0);
  });

  it("badges an extension-less file with the format its MIME type resolves to", () => {
    // Never `"file"` for an advertised type: a queued file under an
    // unrecognized badge reads as a mistake about to happen.
    const badges = SUPPORTED_DOCUMENT_MIME_TYPES.map((mime) =>
      documentExtension("download", mime),
    );

    expect(badges.filter((badge) => badge === "file")).toEqual([]);
    expect(new Set(badges)).toEqual(new Set(Object.keys(DOCUMENT_FORMAT_LABELS)));
  });

  it("rejects an empty file as EMPTY even when its MIME type is supported", () => {
    // Ordering, not acceptance: the size check stays ahead of the format check,
    // so a zero-byte PDF is told what is actually wrong with it.
    const selection = selectBulkDocuments([
      file("report", 0, 1, "application/pdf"),
    ]);

    expect(selection.accepted).toEqual([]);
    expect(selection.rejected[0].reason).toBe("The file is empty.");
  });

  it("names every supported format in the rejection sentence, and nothing else", () => {
    const selection = selectBulkDocuments([file("malware.exe")]);

    expect(selection.rejected).toHaveLength(1);
    const named = selection.rejected[0].reason
      .replace(/^Use\s+/, "")
      .replace(/\.$/, "")
      .split(/,\s*(?:or\s+)?/);

    expect(sorted(named)).toEqual(sorted(Object.values(DOCUMENT_FORMAT_LABELS)));
  });

  it("advertises both derived lists in the accept attribute", () => {
    const advertised = ACCEPTED_DOCUMENT_ATTRIBUTE.split(",");
    const expected = [
      ...SUPPORTED_DOCUMENT_EXTENSIONS.map((ext) => `.${ext}`),
      ...SUPPORTED_DOCUMENT_MIME_TYPES,
    ];

    // Both directions: a missing entry hides a supported format behind the file
    // picker's filter, and an extra one lets through what the server will 400.
    expect(sorted(advertised)).toEqual(sorted(expected));
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
