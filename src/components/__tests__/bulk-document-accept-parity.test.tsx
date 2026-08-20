import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BulkDocumentImport } from "@/components/BulkDocumentImport";
import {
  ACCEPTED_DOCUMENT_ATTRIBUTE,
  documentExtension,
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

    const unqueueable = SUPPORTED_DOCUMENT_EXTENSIONS.filter(
      (ext) => documentExtension(`sample.${ext}`) === "file",
    );
    expect(
      unqueueable,
      `formats the picker offers but the manifest refuses: ${unqueueable.join(", ")}`,
    ).toEqual([]);
  });
});
