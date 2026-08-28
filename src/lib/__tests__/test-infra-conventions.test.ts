/**
 * The three test-infrastructure conventions DW-112 introduced, enforced.
 *
 * Each one was stated in prose (`AGENTS.md`, the modules' own headers) and
 * asserted nowhere. All three fail QUIETLY when broken — a second shim module
 * under `src/` just works, a relative ladder back to `vitest.setup.dom` just
 * works, and a production import of `@/test/dom-helpers` works in every test
 * run and breaks only at `next build`. A convention whose violation is green is
 * a convention that decays.
 *
 * This scan deliberately does NOT use `walkFiles` from `./source-scan`. That
 * helper excludes `__tests__` — correctly, since a scan reading its own
 * assertion text can only ever fail — but the first rule below is ABOUT what
 * test files import, so it has to see inside exactly the directories the shared
 * walk refuses to enter. It uses `readdir(dir, { recursive: true })` instead,
 * the way `workbench-chrome.test.ts` already does for the same reason.
 */
import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SRC = path.resolve(__dirname, "../..");

/**
 * This file, as a `/`-joined `src`-relative path.
 *
 * EXCLUDED FROM ITS OWN SCAN, and this is the one exemption in the file. Every
 * pattern below is written out verbatim as a string literal here — the relative
 * ladder, the `@/test/` specifier — so a guard that read itself would report
 * itself as the only offender and could never go green. The pin in each case
 * below names a file the scan MUST have reached, so this exclusion cannot
 * silently widen into "everything".
 */
const SELF = "lib/__tests__/test-infra-conventions.test.ts";

/** The aliased door, and the only module allowed to hold it. */
const DOM_HELPERS = "test/dom-helpers.ts";

/**
 * Every `.ts`/`.tsx` file under `src/`, as `/`-joined `src`-relative paths,
 * INCLUDING those under `__tests__` — see the header.
 */
async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(SRC, { recursive: true, encoding: "utf8" });
  return entries
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => /\.tsx?$/.test(entry))
    .filter((entry) => entry !== SELF);
}

function read(relative: string): Promise<string> {
  return readFile(path.join(SRC, ...relative.split("/")), "utf8");
}

describe("the dom shim controls are reached through one aliased door (DW-112)", () => {
  it("no file under src/ imports vitest.setup.dom by relative path", async () => {
    const files = await sourceFiles();
    // The scan reached the mounted suites — the only files that could hold
    // such an import at all. Without this, an exclusion that swallowed the
    // tree would leave the assertion below trivially satisfied.
    expect(files).toContain("components/workbench/__tests__/workbench-sheet.test.tsx");
    expect(files).toContain("hooks/__tests__/useSidecarStatus.test.tsx");
    expect(files.length).toBeGreaterThan(300);

    const offenders: string[] = [];
    // The barrel itself is the ONE module that reaches the setup file by
    // relative path — being that single relative import is what it is for, and
    // `@/` cannot express a path outside `src/`. Everything else goes through
    // it. The `re-exports and defines nothing` case below is what keeps this
    // exemption honest.
    for (const file of files.filter((f) => f !== DOM_HELPERS)) {
      // Any relative specifier ending in `vitest.setup.dom` — the ladder was
      // three or four levels deep depending on the suite's own directory, so
      // the depth is not pinned, only the shape.
      if (/from\s+["'](?:\.\.\/)+vitest\.setup\.dom["']/.test(await read(file))) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `Import the shim controls from "@/test/dom-helpers" instead. A relative ` +
        `ladder encodes the importing file's own directory depth, so it ` +
        `resolves somewhere else the moment the suite moves — and the two ` +
        `spellings would be two module instances, which would give the suite ` +
        `a registry the setup file's afterEach never resets.`,
    ).toEqual([]);
  });

  it("no production module imports the test-only barrel", async () => {
    // `@/test/dom-helpers` re-exports `vitest.setup.dom`, which imports `vitest`
    // and `@testing-library/react` (devDependencies) and, at MODULE LOAD,
    // redefines `window.matchMedia`, `HTMLElement.prototype.offsetParent`,
    // `offsetWidth`, `getClientRects` and `Element.prototype.scrollIntoView`.
    // Reached from anything the app bundles, that is a failed `next build` at
    // best and a shimmed prototype in the browser at worst.
    //
    // The old relative ladder pointed OUTSIDE `src/` and so was self-evidently
    // test-only; an `@/`-aliased specifier looks exactly like every other app
    // import, and nothing replaced the signal the ladder used to carry.
    const files = await sourceFiles();
    const production = files.filter(
      (file) => !file.includes("__tests__/") && file !== DOM_HELPERS,
    );
    // The scan reached real production modules, not just test files.
    expect(production).toContain("components/workbench/Workbench.tsx");
    expect(production).toContain("lib/workbench-settings.ts");
    expect(production.length).toBeGreaterThan(200);

    const offenders: string[] = [];
    for (const file of production) {
      if (/from\s+["']@\/test\//.test(await read(file))) offenders.push(file);
    }
    expect(
      offenders,
      `A module outside a __tests__ directory imports the test-only barrel ` +
        `under @/test/. It transitively loads vitest and @testing-library/react ` +
        `(devDependencies) and mutates window.matchMedia and ` +
        `HTMLElement.prototype at import time, so shipping it breaks the build ` +
        `and the browser. Move the shared code somewhere the app may import.`,
    ).toEqual([]);
  });

  it("src/test/dom-helpers.ts re-exports and defines nothing", async () => {
    // AGENTS.md states that `vitest.setup.dom.ts` holds every shim and nothing
    // in `src/` does. That claim survived DW-112 only because this module is a
    // barrel; an implementation added here would falsify the document silently.
    const source = await read(DOM_HELPERS);
    expect(source).toContain('from "../../vitest.setup.dom"');
    // Only `export { … } from` / `export type { … } from` forms. A local
    // `function`, `const`, `class` or a re-implementation of a shim would all
    // introduce a definition.
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const definition of [
      /\bfunction\b/,
      /\bclass\b/,
      /\b(?:const|let|var)\b/,
      /Object\.defineProperty/,
      /\bprototype\b/,
    ]) {
      expect(
        definition.test(withoutComments),
        `src/${DOM_HELPERS} must stay a re-export barrel — it matched ` +
          `${definition}. Every shim lives in vitest.setup.dom.ts; adding an ` +
          `implementation here makes AGENTS.md's "nothing in src/ holds a shim" ` +
          `false, and gives the dom project two module instances of the state ` +
          `the setup file's afterEach resets.`,
      ).toBe(false);
    }
  });

  it("is the only src/ module under a test/ directory", async () => {
    // A second module here would be the natural place for someone to put a
    // shim, so the barrel's "re-exports only" rule is only as strong as the
    // guarantee that it is the whole of `src/test/`.
    const inTestDir = (await sourceFiles()).filter((file) => file.startsWith("test/"));
    expect(inTestDir).toEqual([DOM_HELPERS]);
  });
});

describe("shared test helpers are not collected as suites (DW-117, DW-228)", () => {
  it("every shared helper avoids the *.test.ts(x) suffix", async () => {
    // `vitest.config.ts` collects `*.test.ts` into the node project and
    // `*.test.tsx` into the dom project, and throws at CONFIG LOAD when a
    // `*.test.tsx` falls outside its include. A helper wearing either suffix
    // is collected as a suite with no assertions in it.
    // Keep this list and AGENTS.md's "There are six" bullet in step — the
    // prose and its enforcement are two halves of one convention.
    for (const helper of [
      "lib/__tests__/source-scan.ts",
      "lib/__tests__/discuss-fixtures.ts",
      "lib/__tests__/email-ingest-wire.ts",
      "lib/__tests__/internal-link-fixture.ts",
      "components/workbench/__tests__/settings-harness.tsx",
      DOM_HELPERS,
    ]) {
      // Present…
      expect(await sourceFiles()).toContain(helper);
      // …and not named like a suite.
      expect(/\.test\.tsx?$/.test(helper), `${helper} would be collected`).toBe(false);
    }
  });
});
