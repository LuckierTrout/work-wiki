import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { BulkDocumentImport } from "@/components/BulkDocumentImport";
import {
  ACCEPTED_DOCUMENT_ATTRIBUTE,
  selectBulkDocuments,
} from "@/lib/bulk-document-import";
import { SUPPORTED_DOCUMENT_EXTENSIONS } from "@/lib/document-formats";

/**
 * The bulk-import file inputs advertise the DERIVED allowlist, MOUNTED
 * (DW-246).
 *
 * `BulkDocumentImport.tsx` used to carry a hand-written `ACCEPTED_DOCUMENTS`
 * string — the fourth restatement of the format list, and the one with the
 * quietest failure: too narrow an `accept` means the browser's file picker
 * greys out a supported document, so the user never even sees a rejection
 * reason, let alone the right one.
 *
 * `bulk-document-import.test.ts` pins how that string is ASSEMBLED. It cannot
 * pin that the component uses it — re-pasting a literal into either `accept=`
 * leaves that suite green. So, following the convention
 * `renderer-slug-tenant-adoption.test.tsx` states, this asserts the RENDERED
 * ATTRIBUTE rather than that a module imports a const.
 */

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // `useSlugTenants` fetches `/api/wiki/routes` on mount. Its failure path is
  // graceful, but an unstubbed `fetch` throws synchronously in jsdom.
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fileInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[type="file"]'));
}

describe("bulk import file inputs", () => {
  it("gives every file input the derived accept attribute", () => {
    const { container } = render(<BulkDocumentImport vaultId={null} />);

    const inputs = fileInputs(container);

    // A renamed or removed element must not pass by matching nothing: the
    // component renders a picker input and a folder input, and both take files
    // straight into `selectBulkDocuments`.
    expect(
      inputs.length,
      "no file inputs found — this test would otherwise assert nothing",
    ).toBeGreaterThanOrEqual(2);

    for (const input of inputs) {
      expect(input.getAttribute("accept")).toBe(ACCEPTED_DOCUMENT_ATTRIBUTE);
    }
  });

  it("advertises every extension the client will actually queue", () => {
    const { container } = render(<BulkDocumentImport vaultId={null} />);

    const advertised = new Set(
      (fileInputs(container)[0].getAttribute("accept") ?? "").split(","),
    );

    // The end-to-end claim, independent of how the string is built: a format
    // the picker hides is a format nobody can import, and a format the picker
    // offers but `selectBulkDocuments` rejects is a dead-end selection.
    const unadvertised = SUPPORTED_DOCUMENT_EXTENSIONS.filter(
      (ext) => !advertised.has(`.${ext}`),
    );
    expect(
      unadvertised,
      `supported formats the file picker would hide: ${unadvertised.join(", ")}`,
    ).toEqual([]);

    // `selectBulkDocuments`, not `documentExtension`: since DW-347 the badge
    // helper only chooses a label and the GATE is what decides whether a
    // selection is a dead end. Asking the label helper would leave this claim
    // green while the gate refused everything.
    const unqueueable = SUPPORTED_DOCUMENT_EXTENSIONS.filter(
      (ext) =>
        selectBulkDocuments([
          new File([new Uint8Array(4)], `sample.${ext}`, { lastModified: 1 }),
        ]).accepted.length !== 1,
    );
    expect(
      unqueueable,
      `formats the picker offers but the manifest refuses: ${unqueueable.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * The MANIFEST BADGE reads the derived value, MOUNTED (DW-347).
   *
   * Same reasoning as the `accept` attribute above, one call site over:
   * `bulk-document-import.test.ts` pins what `documentExtension(name, type)`
   * ANSWERS, and nothing there notices if the component asks it the
   * one-argument question. It did until DW-347 — and reverting
   * `BulkDocumentImport.tsx` to `documentExtension(item.file.name)` leaves the
   * entire unit suite green while every extension-less file in the manifest
   * badges "FILE".
   *
   * A `File` named `report` with `type: "application/pdf"` is the ordinary case:
   * the picker's `accept` advertises that content type, so the browser hands
   * these over, and `/api/ingest/document` takes them.
   */
  it("badges a queued MIME-only file with its resolved format", () => {
    const { container } = render(<BulkDocumentImport vaultId={null} />);
    const input = fileInputs(container)[0];
    const picked = new File([new Uint8Array(4)], "report", {
      type: "application/pdf",
      lastModified: 1,
    });

    // `input.files` is read-only in jsdom, so it is defined onto the element
    // rather than passed through `fireEvent`'s `target`.
    Object.defineProperty(input, "files", {
      value: [picked],
      configurable: true,
    });
    fireEvent.change(input);

    // The row exists at all — otherwise the badge assertion below passes
    // vacuously on an empty manifest.
    const row = container.querySelector("li");
    expect(row, "the file was not queued at all").not.toBeNull();
    expect(within(row as HTMLElement).getByText("report")).toBeTruthy();
    expect(
      within(row as HTMLElement).getByText("pdf"),
      "the manifest badge did not resolve the file's content type",
    ).toBeTruthy();
  });
});
