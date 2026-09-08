import { readFile } from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";
import { REPAIR_HINT, URL_MAX_CHARS } from "../research-contract";
import { researchRegistryRepairable } from "../research-panel";

/**
 * `src/lib/research-panel.ts` must stay importable from a client bundle, and
 * `src/lib/research-contract.ts` is what keeps it that way.
 *
 * This is the same invariant `document-formats-client-safety.test.ts` guards one
 * module over, and it is here because the condition already SHIPPED once.
 * `research-panel.ts` is client vocabulary — `GraphCanvas`, `ResearchCanvas`,
 * `ReviewCanvas` and `KnowledgeStudio` import it — and it took `REPAIR_HINT` and
 * `URL_MAX_CHARS` as a VALUE import off `research-projects.ts`, which reaches
 * `./storage` → `storage/filesystem.ts` → `node:fs/promises`. Turbopack refuses
 * to chunk that for the browser ("the chunking context does not support external
 * modules") and the whole Workbench renders nothing: every browser spec in
 * `e2e/` failed on `next dev` with no page at all. The two constants moved DOWN
 * into a leaf module to fix it.
 *
 * NOTHING IN THE TYPE SYSTEM ENFORCES ANY OF THAT. `research-projects.ts`
 * re-exports both names, so the import that caused the outage is still spelled
 * exactly the way it was and still type-checks — one future
 * `import { REPAIR_HINT } from "./research-projects"` in the panel restores the
 * failure in full, and the only symptom is a dev server that serves a blank
 * shell. So the invariant is read back out of the source and looked at.
 *
 * Value imports only. `import type` is erased before it reaches a bundle and is
 * explicitly allowed by both modules' contracts — the panel's own
 * `import type … from "./research-projects"` is fine and must stay.
 */

const CONTRACT = "src/lib/research-contract.ts";
const PANEL = "src/lib/research-panel.ts";
const ROOT = path.resolve(__dirname, "../..", "..");

/** A value import: anything that survives type erasure and pulls in a module. */
function valueImports(module: string, source: string): string[] {
  return source.split("\n").reduce<string[]>((offending, line, index) => {
    const at = `${module}:${index + 1}: ${line.trim()}`;
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

/** The module each offending line reaches, for the "only this one" assertion. */
function specifiers(lines: readonly string[]): string[] {
  return lines.map((line) => {
    const found = /["']([^"']+)["']/.exec(line);
    return found ? found[1] : line;
  });
}

describe("research-panel stays safe in a client bundle", () => {
  it("gives research-contract.ts no value import of any kind", async () => {
    // `readFile` REJECTS on a missing or unreadable file, so a moved module
    // fails this suite loudly instead of scanning an empty string and passing.
    const source = await readFile(path.join(ROOT, CONTRACT), "utf8");

    // Guard against a vacuous pass: an empty read, or a read of some other
    // file, must not look like "no imports found".
    expect(
      source.length,
      `${CONTRACT} read back empty — the invariant was not actually checked`,
    ).toBeGreaterThan(500);
    expect(
      source,
      `${CONTRACT} does not contain the constants this test exists to protect`,
    ).toContain("export const REPAIR_HINT");

    const offending = valueImports(CONTRACT, source);

    expect(
      offending,
      `${CONTRACT} must have NO value imports so it can be bundled for the ` +
        `browser — it is the leaf both the store and the panel read. One ` +
        `import here, however innocent, is inherited by every client that ` +
        `reaches it. Offending lines:\n${offending.join("\n")}`,
    ).toEqual([]);
  });

  it("leaves research-panel.ts reaching only that leaf at runtime", async () => {
    const source = await readFile(path.join(ROOT, PANEL), "utf8");

    expect(
      source.length,
      `${PANEL} read back empty — the invariant was not actually checked`,
    ).toBeGreaterThan(500);
    expect(
      source,
      `${PANEL} does not contain the predicate this test exists to protect`,
    ).toContain("export function researchRegistryRepairable");

    // Not "no value imports": the panel is allowed to reach the leaf, and has
    // to. What it may not reach is anything that carries a runtime dependency
    // of its own — `./research-projects` above all.
    expect(
      specifiers(valueImports(PANEL, source)),
      `${PANEL} is imported by the Workbench canvases, so every value import ` +
        `here lands in the browser graph. Only "./research-contract" may be ` +
        `one — a value import of "./research-projects" pulls ./storage and ` +
        `node:fs/promises in behind it and Turbopack cannot chunk that.`,
    ).toEqual(["./research-contract"]);

    // …and the store is still reached for its TYPES, which is the whole reason
    // the constants had to move rather than the type import being dropped. A
    // future edit that widens this line back to a value import is the outage.
    expect(
      source,
      `${PANEL} must keep its "./research-projects" import type-only`,
    ).toMatch(/^import type \{[^}]*\} from "\.\/research-projects";$/m);
  });

  it("still exports the constants both sides read, so the guard is not protecting an empty file", () => {
    // Imported at the top of this file: a contract emptied out, renamed or
    // reduced to types would fail to resolve here before any scan ran.
    expect(REPAIR_HINT.length).toBeGreaterThan(0);
    expect(URL_MAX_CHARS).toBeGreaterThan(0);
    // …and the panel still derives its predicate from the marker rather than
    // retyping the sentence, which is what makes the shared constant load-bearing
    // instead of merely tidy.
    expect(researchRegistryRepairable(`Broken.${REPAIR_HINT}`)).toBe(true);
    expect(researchRegistryRepairable("Broken.")).toBe(false);
  });
});
