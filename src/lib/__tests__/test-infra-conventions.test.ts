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
 * The Settings mount harness, which lives beside the barrel for the same reason
 * (DW-471): a mounted suite under `src/app/settings/__tests__/` needs it, and
 * `./settings-harness` only ever reached the one directory it sat in.
 */
const SETTINGS_HARNESS = "test/settings-harness.tsx";

/**
 * Everything under `src/test/` — test-only by construction, and therefore never
 * "production" for the two scans below.
 */
function isTestOnly(file: string): boolean {
  return file.startsWith("test/");
}

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
    // `offsetWidth`, `getClientRects`, `Element.prototype.scrollIntoView`,
    // and `window`/`globalThis` Storage.
    // Reached from anything the app bundles, that is a failed `next build` at
    // best and a shimmed prototype in the browser at worst.
    //
    // The old relative ladder pointed OUTSIDE `src/` and so was self-evidently
    // test-only; an `@/`-aliased specifier looks exactly like every other app
    // import, and nothing replaced the signal the ladder used to carry.
    const files = await sourceFiles();
    const production = files.filter(
      (file) => !file.includes("__tests__/") && !isTestOnly(file),
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

  it("no production module imports a test-only `_` seam from useSlugTenants", async () => {
    // `useSlugTenants.ts` is a client module the app SHIPS, and three of its
    // exports exist only so suites can drive the slug→tenant singleton:
    // `_resetSlugTenants` (drop the session cache), `_subscribeSlugTenants`
    // (register a listener the hook would never produce) and
    // `_slugTenantListenerCount`. Unlike the `@/test/` barrel above they carry
    // no import-time side effect and no devDependency, so a production call
    // site would build, ship, and simply be wrong: a shipped
    // `_resetSlugTenants()` re-opens DW-87 for real owners by throwing away a
    // good map mid-session. The `_` prefix and the doc comments are prose; this
    // is the enforcement.
    const files = await sourceFiles();
    const production = files.filter(
      (file) => !file.includes("__tests__/") && !isTestOnly(file),
    );
    // The scan reached the module that DEFINES them, which is the one
    // production file guaranteed to mention the names — so an exclusion that
    // swallowed the tree cannot leave this trivially satisfied.
    expect(production).toContain("hooks/useSlugTenants.ts");
    expect(production.length).toBeGreaterThan(200);

    const offenders: string[] = [];
    for (const file of production.filter((f) => f !== "hooks/useSlugTenants.ts")) {
      if (/_resetSlugTenants|_subscribeSlugTenants|_slugTenantListenerCount/.test(await read(file))) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `A module outside a __tests__ directory references a test-only seam of ` +
        `hooks/useSlugTenants.ts. Those exports drive the session cache the ` +
        `whole app reads: resetting or subscribing to it from shipped code ` +
        `puts every in-content link back on the DEFAULT_TENANT 308 hop. App ` +
        `code gets the map from useSlugTenants().`,
    ).toEqual([]);
  });

  it("src/test/dom-helpers.ts re-exports and defines nothing", async () => {
    // AGENTS.md states that `vitest.setup.dom.ts` holds every shim and nothing
    // in `src/` does. That claim survived DW-112 only because this module is a
    // barrel; an implementation added here would falsify the document silently.
    const source = await read(DOM_HELPERS);
    expect(source).toContain('from "../../vitest.setup.dom"');
    // DW-588: the Storage reset is a first-class control, same as the others.
    // A barrel that forgot to re-export it would leave suites importing a
    // function the setup file's afterEach never shares.
    expect(source).toContain("resetDomStorage");
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

  it("src/test/settings-harness.tsx defines no shim of its own", async () => {
    // The barrel's "re-exports and defines nothing" rule above covers
    // `dom-helpers.ts` and nothing else, and it CANNOT be widened to cover this
    // module: the harness is a real implementation — it defines functions and
    // consts by design, so every pattern that case tests for is legitimate
    // here. Before DW-471 the whole of `src/test/` was one barrel, and the
    // "exactly one module" pin was what made that rule load-bearing for the
    // directory; a second module took that cover away.
    //
    // What survives is the part that matters: `AGENTS.md` claims
    // `vitest.setup.dom.ts` holds every shim and nothing in `src/` does. The
    // relative-import case at the top of this file already catches a harness
    // that reached the setup file by ladder, but an INLINE shim — a
    // `defineProperty` on a prototype, the way the setup file installs
    // `offsetParent` and `getClientRects` — would import nothing and pass it.
    // So the two patterns that spell "shim" are pinned directly.
    const source = await read(SETTINGS_HARNESS);
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const shim of [/Object\.defineProperty/, /\bprototype\b/]) {
      expect(
        shim.test(withoutComments),
        `src/${SETTINGS_HARNESS} matched ${shim}. It is a mount harness, not a ` +
          `place for a DOM shim: every shim lives in vitest.setup.dom.ts, ` +
          `reached through ${DOM_HELPERS}, so that the dom project has ONE ` +
          `module instance of the state the setup file's afterEach resets. ` +
          `Adding one here also makes AGENTS.md's "nothing in src/ holds a ` +
          `shim" false.`,
      ).toBe(false);
    }
  });

  it("holds only the two modules that must be aliasable", async () => {
    // A THIRD module here would be the natural place for someone to put a
    // shim, so the barrel's "re-exports only" rule is only as strong as the
    // guarantee that it and the harness are the whole of `src/test/`.
    //
    // The barrel rule itself is held by the case ABOVE, which reads
    // `DOM_HELPERS` by name — so widening this list to two does not weaken it.
    // A module earns a place here only by needing to be reached as `@/test/…`
    // from more than one directory; anything else belongs beside its suites.
    const inTestDir = (await sourceFiles()).filter(isTestOnly);
    expect(inTestDir.slice().sort()).toEqual([DOM_HELPERS, SETTINGS_HARNESS].sort());
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
      SETTINGS_HARNESS,
      DOM_HELPERS,
    ]) {
      // Present…
      expect(await sourceFiles()).toContain(helper);
      // …and not named like a suite.
      expect(/\.test\.tsx?$/.test(helper), `${helper} would be collected`).toBe(false);
    }
  });
});
