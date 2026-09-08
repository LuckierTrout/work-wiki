import { readFile } from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_FORMATS,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from "../document-formats";

/**
 * `src/lib/document-formats.ts` must stay importable from a client bundle
 * (DW-246).
 *
 * The module exists for exactly one reason: the format tables used to live in
 * `./document-extract`, whose head imports `fflate` and `./vision` (→
 * `./storage`, `./llm`), so nothing client-side could reach them — and
 * `bulk-document-import.ts` plus `BulkDocumentImport.tsx` therefore kept
 * hand-written copies that fell seven formats behind. Moving the tables to a
 * leaf module with NO imports is what let those copies be deleted.
 *
 * Nothing in the type system enforces that. One future
 * `import { MAX_DOCUMENT_SIZE } from "./constants"` — or worse, a path that
 * transitively reaches `./vision` again — would silently restore the original
 * condition, and the only symptom would be a bundler error in a deploy, or the
 * next person re-adding a hand-copy because "you can't import that from the
 * client". So the invariant is asserted the way
 * `prose-inventory-parity.test.ts` asserts its prose: read the source back and
 * look at it.
 *
 * Value imports only. `import type` is erased before it reaches a bundle and is
 * explicitly allowed by the module's contract.
 */

const MODULE = "src/lib/document-formats.ts";
const modulePath = path.resolve(__dirname, "../..", "..", MODULE);

/** A value import: anything that survives type erasure and pulls in a module. */
function valueImports(source: string): string[] {
  return source.split("\n").reduce<string[]>((offending, line, index) => {
    const at = `${MODULE}:${index + 1}: ${line.trim()}`;
    const isTypeOnly = /^\s*(?:import|export)\s+type\b/.test(line);
    if (isTypeOnly) return offending;

    // Static `import … from "…"` / bare `import "…"`, static re-exports
    // (`export … from "…"` emits a runtime dependency just as an import does),
    // dynamic `import(…)`, and CommonJS `require(…)`.
    const offends =
      /^\s*import\b/.test(line) ||
      (/^\s*export\b/.test(line) && /\bfrom\b/.test(line)) ||
      /\bimport\s*\(/.test(line) ||
      /\brequire\s*\(/.test(line);

    return offends ? [...offending, at] : offending;
  }, []);
}

describe("document-formats stays safe in a client bundle", () => {
  it("declares no value import of any kind", async () => {
    // `readFile` REJECTS on a missing or unreadable file, so a moved module
    // fails this suite loudly instead of scanning an empty string and passing.
    const source = await readFile(modulePath, "utf8");

    // Guard against a vacuous pass: an empty read, or a read of some other
    // file, must not look like "no imports found".
    expect(
      source.length,
      `${MODULE} read back empty — the invariant was not actually checked`,
    ).toBeGreaterThan(500);
    expect(
      source,
      `${MODULE} does not contain the tables this test exists to protect`,
    ).toContain("export const DOCUMENT_FORMATS");

    const offending = valueImports(source);

    expect(
      offending,
      `${MODULE} must have NO value imports so it can be bundled for the ` +
        `browser — bulk import reads its tables from here. Offending lines:\n` +
        offending.join("\n"),
    ).toEqual([]);
  });

  it("still exports usable tables, so the guard is not protecting an empty file", () => {
    expect(DOCUMENT_FORMATS.length).toBeGreaterThan(0);
    expect(SUPPORTED_DOCUMENT_EXTENSIONS.length).toBeGreaterThanOrEqual(
      DOCUMENT_FORMATS.length,
    );
  });
});
